const { MongoClient } = require('mongodb');
const Pusher = require('pusher');

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    try {
        if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
        if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');

        const client = await MongoClient.connect(process.env.MONGODB_URI, {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
        });
        const db = client.db('exile_clash');
        cachedClient = client;
        cachedDb = db;
        return { client, db };
    } catch (error) {
        console.error('DB Connection Error:', error);
        throw new Error('Database connection failed');
    }
}

const pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: '52d629612765e85a5546',
    secret: process.env.PUSHER_SECRET,
    cluster: 'ap2',
    useTLS: true
});

// Debounce map for state-update events to reduce rapid Pusher triggers
const debounceTimers = new Map();
const DEBOUNCE_DELAY = 100; // 100ms debounce for state updates

function debouncedStateUpdate(lobbyId) {
    if (debounceTimers.has(lobbyId)) {
        clearTimeout(debounceTimers.get(lobbyId));
    }
    const timer = setTimeout(() => {
        pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        debounceTimers.delete(lobbyId);
    }, DEBOUNCE_DELAY);
    debounceTimers.set(lobbyId, timer);
}

const SHOP_ITEMS = {
    shields: { cost: 1, max: 3 },
    canon: { cost: 1, max: 3 },
    slicer: { cost: 1, max: 3 }
};

const PHASE_DURATIONS = { rps: 15, coin: 20 };
const HOST_TIMEOUT = 30 * 1000;

// FIX: increased empty lobby timeout from 1min to 2min to avoid deleting newly-created lobbies
async function cleanupInactiveLobbies(db) {
    try {
        const now = Date.now();
        const twoMinAgo = new Date(now - 2 * 60 * 1000);
        const thirtyMinAgo = new Date(now - 30 * 60 * 1000);
        const fiveMinAgo = new Date(now - 5 * 60 * 1000);

        // 1. Delete empty waiting lobbies after 2min (not just 1 player - must be truly empty or abandoned)
        // Only delete if created more than 2min ago AND no activity in 2min
        const emptyResult = await db.collection('lobbies').deleteMany({
            status: 'waiting',
            players: { $size: 1 },
            created_at: { $lt: twoMinAgo },
            updated_at: { $lt: twoMinAgo }
        });

        // 2. Check host timeout and transfer (30 second inactivity = host likely AFK)
        const staleLobbies = await db.collection('lobbies').find({
            status: { $in: ['waiting', 'playing'] },
            updated_at: { $lt: new Date(now - HOST_TIMEOUT) }
        }).toArray();

        for (const lobby of staleLobbies) {
            const host = lobby.players.find(p => p.uid === lobby.host_uid);
            // Only transfer to human players, not bots
            const alivePlayers = lobby.players.filter(p => !p.is_dead && !p.uid.startsWith('bot_'));

            // If host is dead or doesn't exist, transfer to next human player
            if (!host || host.is_dead) {
                if (alivePlayers.length > 0) {
                    // Sort by join time to get the oldest player (most likely to be active)
                    const newHost = alivePlayers.sort((a, b) => a.joined_at - b.joined_at)[0];
                    await db.collection('lobbies').updateOne(
                        { _id: lobby._id },
                        { $set: { host_uid: newHost.uid, updated_at: new Date() } }
                    );
                    await pusher.trigger(`game-${lobby._id}`, 'host-transferred', { new_host: newHost.uid });
                    console.log(`Host transferred in ${lobby._id} to ${newHost.name}`);
                } else {
                    // No human players left - delete the lobby
                    await db.collection('lobbies').deleteOne({ _id: lobby._id });
                    await pusher.trigger('presence-global', 'lobby-deleted', { lobby_id: lobby._id });
                    console.log(`Deleted stale lobby ${lobby._id} (no human players)`);
                }
            }
        }

        // 3. Delete old finished games
        await db.collection('lobbies').deleteMany({
            status: 'finished',
            updated_at: { $lt: fiveMinAgo }
        });

        if (emptyResult.deletedCount > 0) {
            console.log(`Deleted ${emptyResult.deletedCount} inactive lobbies`);
        }
    } catch (error) {
        console.error('Cleanup Error:', error);
    }
}

async function checkAllCoinsZero(lobbyId, db) {
    try {
        const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
        if (!lobby || lobby.phase !== 'coin') return;

        const alivePlayers = lobby.players.filter(p => !p.is_dead);
        // Only coins block the next round — weapons carry over so we ignore them here
        const allZero = alivePlayers.every(p => p.coins === 0);

        if (allZero && alivePlayers.length > 1) {
            await startNextRound(lobbyId, db);
        }
    } catch (error) {
        console.error('Check Coins Error:', error);
    }
}

async function startNextRound(lobbyId, db) {
    try {
        const phaseEndTime = Math.floor(Date.now() / 1000) + PHASE_DURATIONS.rps;

        await db.collection('lobbies').updateOne(
            { _id: lobbyId },
            {
                $set: {
                    phase: 'rps',
                    phase_end_time: phaseEndTime,
                    'players.$[].rps_choice': null,
                    'players.$[].rps_result': null,
                    updated_at: new Date()
                }
            }
        );

        // FIX: bots pick immediately so they never cause a guaranteed draw loop
        await botPickRPS(lobbyId, db);
        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
    } catch (error) {
        console.error('Start Next Round Error:', error);
    }
}

// FIX: Bots pick their RPS choice with weighted strategies (not pure random).
// Weighted strategy: rock 40%, paper 35%, scissors 25%
// This creates non-trivial gameplay without being too predictable.
function getBotRPSChoice(botId, roundNumber = 0) {
    const rand = Math.random() * 100;
    if (rand < 40) return 'rock';
    if (rand < 75) return 'paper';
    return 'scissors';
}

// FIX: Bots pick their RPS choice right when the phase starts with weighted strategies.
// Previously bots only got a random choice assigned inside resolveRPSPhase,
// meaning every round had a 1-in-3 chance of a "full draw" → infinite reset loop.
// Now bots pick proactively with weighted strategies, and resolution works correctly every time.
async function botPickRPS(lobbyId, db) {
    try {
        const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
        if (!lobby) return;
        const bots = lobby.players.filter(p => p.uid.startsWith('bot_') && !p.is_dead);
        for (const bot of bots) {
            const botChoice = getBotRPSChoice(bot.uid, lobby.round || 0);
            await db.collection('lobbies').updateOne(
                { _id: lobbyId, 'players.uid': bot.uid },
                { $set: { 'players.$.rps_choice': botChoice, updated_at: new Date() } }
            );
        }
    } catch (error) {
        console.error('Bot Pick RPS Error:', error);
    }
}

// FIX: Completely rewrote RPS resolution logic.
// Old logic had a broken multi-player win condition:
//   wins < players.length / 2 - 1  → would never assign LOSE for 2-player games (0 < 0)
//   totalDraws === players.length  → never true in a proper 2-player match
// New logic: In a 2+ player FFA, you WIN if you beat ALL opponents, LOSE if you beat NONE.
// Everything else is a DRAW. Full draw → replay RPS.
async function resolveRPSPhase(lobbyId, db) {
    try {
        const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
        if (!lobby || lobby.phase !== 'rps') return { error: 'Not RPS phase' };

        const alivePlayers = lobby.players.filter(p => !p.is_dead);
        if (alivePlayers.length < 2) return { error: 'Not enough players' };

        const choices = ['rock', 'paper', 'scissors'];

        // Auto-pick for AFK HUMAN players only (bots already picked via botPickRPS)
        const updates = [];
        for (const player of alivePlayers) {
            if (!player.rps_choice) {
                const randomChoice = choices[Math.floor(Math.random() * 3)];
                updates.push({
                    updateOne: {
                        filter: { _id: lobbyId, 'players.uid': player.uid },
                        update: { $set: { 'players.$.rps_choice': randomChoice } }
                    }
                });
            }
        }
        if (updates.length > 0) await db.collection('lobbies').bulkWrite(updates);

        const updatedLobby = await db.collection('lobbies').findOne({ _id: lobbyId });
        const players = updatedLobby.players.filter(p => !p.is_dead);

        // Determine wins-against for each player
        const winsAgainst = (c1, c2) =>
            (c1 === 'rock' && c2 === 'scissors') ||
            (c1 === 'paper' && c2 === 'rock') ||
            (c1 === 'scissors' && c2 === 'paper');

        const playerResults = players.map(p => {
            let wins = 0;
            let losses = 0;
            for (const other of players) {
                if (other.uid === p.uid) continue;
                if (winsAgainst(p.rps_choice, other.rps_choice)) wins++;
                if (winsAgainst(other.rps_choice, p.rps_choice)) losses++;
            }
            return { player: p, wins, losses };
        });

        const opponents = players.length - 1;
        // A player WINS if they beat everyone; LOSE if beaten by everyone; else DRAW
        const isFullDraw = playerResults.every(r => r.wins === 0 && r.losses === 0);

        // Full draw (everyone picked same) → bots re-pick a DIFFERENT choice to guarantee no infinite loop
        if (isFullDraw) {
            const humanChoices = players.filter(p => !p.uid.startsWith('bot_')).map(p => p.rps_choice);
            const humanChoice = humanChoices[0]; // in 2-player: the one human's choice
            const botResets = [];
            for (const p of players) {
                if (p.uid.startsWith('bot_')) {
                    // Pick a choice that beats the human — guaranteed non-draw
                    const winningChoice = choices.find(c => winsAgainst(c, humanChoice)) || choices[Math.floor(Math.random() * 3)];
                    botResets.push({
                        updateOne: {
                            filter: { _id: lobbyId, 'players.uid': p.uid },
                            update: { $set: { 'players.$.rps_choice': winningChoice } }
                        }
                    });
                }
            }
            if (botResets.length > 0) {
                await db.collection('lobbies').bulkWrite(botResets);
                // Re-run resolution immediately — no reset needed, just recurse once
                return resolveRPSPhase(lobbyId, db);
            }
            // Pure human draw — reset and ask again
            const phaseEndTime = Math.floor(Date.now() / 1000) + PHASE_DURATIONS.rps;
            await db.collection('lobbies').updateOne(
                { _id: lobbyId },
                {
                    $set: {
                        phase: 'rps',
                        phase_end_time: phaseEndTime,
                        'players.$[].rps_choice': null,
                        'players.$[].rps_result': null,
                        updated_at: new Date()
                    }
                }
            );
            await pusher.trigger(`game-${lobbyId}`, 'rps-draw', { message: 'Draw! Choose again!' });
            // FIX: bots re-pick immediately on draw reset too
            await botPickRPS(lobbyId, db);
            return { success: true, draw: true };
        }

        // Assign results and coins
        // coins = opponents beaten this round (fresh each round — NOT carried over)
        // weapons (canon, slicer, shields) DO carry over to next round
        const resultUpdates = [];
        for (const { player, wins, losses } of playerResults) {
            let result = 'DRAW';
            if (wins === opponents) result = 'WIN';
            else if (losses === opponents) result = 'LOSE';

            resultUpdates.push({
                updateOne: {
                    filter: { _id: lobbyId, 'players.uid': player.uid },
                    update: {
                        $set: {
                            'players.$.rps_result': result,
                            'players.$.coins': wins   // reset to this round's earnings only
                        }
                    }
                }
            });
        }
        if (resultUpdates.length > 0) await db.collection('lobbies').bulkWrite(resultUpdates);

        // Advance to coin phase
        const coinPhaseEnd = Math.floor(Date.now() / 1000) + PHASE_DURATIONS.coin;
        await db.collection('lobbies').updateOne(
            { _id: lobbyId },
            {
                $set: {
                    phase: 'coin',
                    phase_end_time: coinPhaseEnd,
                    updated_at: new Date()
                }
            }
        );

        await pusher.trigger(`game-${lobbyId}`, 'rps-resolved', {});
        // Bots act automatically in coin phase (delay lets clients see the transition first)
        setTimeout(() => botTurn(lobbyId, db), 800);
        return { success: true };
    } catch (error) {
        console.error('Resolve RPS Error:', error);
        return { error: 'Failed to resolve RPS' };
    }
}

async function botTurn(lobbyId, db) {
    try {
        const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
        if (!lobby || lobby.phase !== 'coin') return;

        const aliveBots = lobby.players.filter(p => p.uid.startsWith('bot_') && !p.is_dead);
        if (aliveBots.length === 0) return;

        for (const botSnap of aliveBots) {
            // --- Re-fetch fresh state before every bot action ---
            const current = await db.collection('lobbies').findOne({ _id: lobbyId });
            if (!current || current.phase !== 'coin') return;

            const bot = current.players.find(p => p.uid === botSnap.uid);
            if (!bot || bot.is_dead) continue;

            // 1. Spend all coins: prefer slicer over cannon (more aggressive), buy shields if health < 2
            let coinsLeft = bot.coins;
            while (coinsLeft > 0) {
                const itemKeys = Object.keys(SHOP_ITEMS);
                // Smart buying: if health is low, buy shields first; otherwise prefer slicer
                let preferred = bot.health < 2 ? ['shields', 'slicer', 'canon'] : ['slicer', 'canon', 'shields'];
                const item = preferred.find(k => bot[k] < SHOP_ITEMS[k].max) || itemKeys.find(k => bot[k] < SHOP_ITEMS[k].max);
                if (!item) break;
                await db.collection('lobbies').updateOne(
                    { _id: lobbyId, 'players.uid': bot.uid },
                    { $inc: { 'players.$.coins': -1, [`players.$.${item}`]: 1 }, $set: { updated_at: new Date() } }
                );
                bot[item] = (bot[item] || 0) + 1;
                bot.coins -= 1;
                coinsLeft--;
            }

            // 2. Use ALL weapons — attack until no weapons left
            let attackLoop = 0;
            while (attackLoop < 10) {
                attackLoop++;
                // Re-fetch bot's current weapon counts
                const freshLobby = await db.collection('lobbies').findOne({ _id: lobbyId });
                if (!freshLobby || freshLobby.phase !== 'coin') return;
                const freshBot = freshLobby.players.find(p => p.uid === bot.uid);
                if (!freshBot || freshBot.is_dead) break;

                // Prefer slicer (direct damage) over cannon (shield break) for more aggressive gameplay
                const weapon = freshBot.slicer > 0 ? 'slicer' : freshBot.canon > 0 ? 'canon' : null;
                if (!weapon) break; // no weapons left

                // Pick target: prioritize weakest opponent (lowest health, no shields)
                const enemies = freshLobby.players.filter(p => !p.is_dead && p.uid !== bot.uid);
                if (enemies.length === 0) break;
                // Sort by: shields (ascending), then health (ascending) - weakest first
                const sortedEnemies = enemies.sort((a, b) => {
                    if (a.shields !== b.shields) return a.shields - b.shields;
                    return a.health - b.health;
                });
                const target = sortedEnemies[0];
                const freshTarget = freshLobby.players.find(p => p.uid === target.uid);
                if (!freshTarget || freshTarget.is_dead) continue;

                // Decrement weapon
                await db.collection('lobbies').updateOne(
                    { _id: lobbyId, 'players.uid': freshBot.uid },
                    { $inc: { [`players.$.${weapon}`]: -1 }, $set: { updated_at: new Date() } }
                );

                // Apply effect
                if (weapon === 'canon') {
                    if (freshTarget.shields > 0) {
                        await db.collection('lobbies').updateOne(
                            { _id: lobbyId, 'players.uid': freshTarget.uid },
                            { $inc: { 'players.$.shields': -1 }, $set: { updated_at: new Date() } }
                        );
                    }
                    // cannon does nothing if no shields (by design)
                } else if (weapon === 'slicer') {
                    if (freshTarget.shields === 0) {
                        const newHealth = Math.max(0, freshTarget.health - 1);
                        const isDead = newHealth === 0;
                        await db.collection('lobbies').updateOne(
                            { _id: lobbyId, 'players.uid': freshTarget.uid },
                            { $set: { 'players.$.health': newHealth, 'players.$.is_dead': isDead, updated_at: new Date() } }
                        );
                        if (isDead) {
                            // Check if game is over after this kill
                            const afterKill = await db.collection('lobbies').findOne({ _id: lobbyId });
                            const alive = afterKill.players.filter(p => !p.is_dead);
                            if (alive.length === 1) {
                                await db.collection('lobbies').updateOne(
                                    { _id: lobbyId },
                                    { $set: { status: 'finished', phase: 'finished', updated_at: new Date() } }
                                );
                                await pusher.trigger(`game-${lobbyId}`, 'game-ended', { winner: alive[0] });
                                return;
                            }
                        }
                    }
                }
            }
        }

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        await checkAllCoinsZero(lobbyId, db);
    } catch (error) {
        console.error('Bot Turn Error:', error);
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { db } = await connectToDatabase();
        await cleanupInactiveLobbies(db);

        const { action } = req.method === 'GET' ? req.query : req.body;
        if (!action) return res.status(400).json({ error: 'Action required' });

        // === ADMIN ACTIONS ===
        if (action === 'admin_login') {
            const { username, password } = req.body;
            if (!username || !password) return res.json({ error: 'Credentials required' });

            if (username === 'Nethindu' && password === '1234') {
                return res.json({ success: true, token: 'admin_token_exile_1234' });
            }
            return res.json({ error: 'Invalid credentials' });
        }

        if (action === 'delete_lobby') {
            const { lobby_id, admin_token } = req.body;
            if (!lobby_id) return res.json({ error: 'Lobby ID required' });
            if (admin_token !== 'admin_token_exile_1234') {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            const result = await db.collection('lobbies').deleteOne({ _id: lobby_id });
            if (result.deletedCount > 0) {
                await pusher.trigger('presence-global', 'lobby-deleted', { lobby_id });
                return res.json({ success: true, message: 'Lobby deleted' });
            }
            return res.json({ error: 'Lobby not found' });
        }

        if (action === 'get_all_lobbies') {
            const { admin_token } = req.body;
            if (admin_token !== 'admin_token_exile_1234') {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            const lobbies = await db.collection('lobbies')
                .find({})
                .sort({ created_at: -1 })
                .limit(50)
                .toArray();
            return res.json({ lobbies });
        }

        // === GAME ACTIONS ===
        if (action === 'create_lobby') {
            const { uid, name, is_public, player_name } = req.body;
            if (!uid) return res.json({ error: 'User ID required' });

            const lobbyName = (name || 'Exile Clash').trim();
            if (lobbyName.length < 3) return res.json({ error: 'Lobby name too short' });
            if (lobbyName.length > 30) return res.json({ error: 'Lobby name too long' });

            const existingLobby = await db.collection('lobbies').findOne({
                name: lobbyName,
                status: { $in: ['waiting', 'playing'] }
            });

            if (existingLobby) {
                return res.json({ error: 'Lobby name already taken! Choose another name 🐻' });
            }

            const lobbyId = Math.random().toString(36).substring(2, 8).toUpperCase();
            const now = new Date();

            const lobby = {
                _id: lobbyId,
                name: lobbyName,
                is_public: is_public ? 1 : 0,
                host_uid: uid,
                status: 'waiting',
                phase: 'lobby',
                players: [{
                    uid,
                    name: (player_name || 'Player').trim().substring(0, 20),
                    island: Math.floor(Math.random() * 6) + 1,
                    health: 4,
                    coins: 0,
                    shields: 0,
                    canon: 0,
                    slicer: 0,
                    rps_choice: null,
                    rps_result: null,
                    is_dead: false,
                    joined_at: now
                }],
                created_at: now,
                updated_at: now,
                phase_end_time: null
            };

            await db.collection('lobbies').insertOne(lobby);
            await pusher.trigger('presence-global', 'lobby-created', { lobby_id: lobbyId });
            return res.json({ success: true, lobby_id: lobbyId });
        }

        if (action === 'join_lobby') {
            const { lobby_id, uid, player_name } = req.body;
            if (!lobby_id || !uid) return res.json({ error: 'Lobby ID and User ID required' });

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });
            if (lobby.status !== 'waiting') return res.json({ error: 'Game already started' });
            if (lobby.players.length >= 6) return res.json({ error: 'Lobby full' });
            if (lobby.players.find(p => p.uid === uid)) return res.json({ success: true });

            const now = new Date();
            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                {
                    $push: {
                        players: {
                            uid,
                            name: (player_name || 'Player').trim().substring(0, 20),
                            island: Math.floor(Math.random() * 6) + 1,
                            health: 4,
                            coins: 0,
                            shields: 0,
                            canon: 0,
                            slicer: 0,
                            rps_choice: null,
                            rps_result: null,
                            is_dead: false,
                            joined_at: now
                        }
                    },
                    $set: { updated_at: now }
                }
            );

            debouncedStateUpdate(lobby_id);
            return res.json({ success: true });
        }

        // FIX: Added remove_bot action so the host can actually remove bots from lobby
        if (action === 'remove_bot') {
            const { lobby_id, uid } = req.body;
            if (!lobby_id || !uid) return res.json({ error: 'Lobby ID and User ID required' });

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });
            if (lobby.host_uid !== uid) return res.json({ error: 'Only host can remove bots' });

            // Find last bot in the players list
            const bots = lobby.players.filter(p => p.uid.startsWith('bot_'));
            if (bots.length === 0) return res.json({ error: 'No bots to remove' });

            const lastBot = bots[bots.length - 1];
            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                {
                    $pull: { players: { uid: lastBot.uid } },
                    $set: { updated_at: new Date() }
                }
            );

            debouncedStateUpdate(lobby_id);
            return res.json({ success: true });
        }

        if (action === 'get_state') {
            const { lobby_id } = req.method === 'GET' ? req.query : req.body;
            if (!lobby_id) return res.json({ error: 'Lobby ID required' });

            // Use cached lobby state when possible to reduce DB reads
            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });

            // Only update timestamp if more than 5 seconds have passed (reduce write frequency)
            const now = new Date();
            if (!lobby.updated_at || now - lobby.updated_at > 5000) {
                await db.collection('lobbies').updateOne(
                    { _id: lobby_id },
                    { $set: { updated_at: now } }
                );
            }

            return res.json({ lobby });
        }

        if (action === 'get_public_lobbies') {
            const lobbies = await db.collection('lobbies')
                .find({ is_public: 1, status: 'waiting' })
                .sort({ created_at: -1 })
                .limit(10)
                .toArray();
            return res.json({ lobbies });
        }

        if (action === 'start_game') {
            const { lobby_id } = req.body;
            if (!lobby_id) return res.json({ error: 'Lobby ID required' });

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });
            if (lobby.players.length < 2) return res.json({ error: 'Need at least 2 players' });

            const phaseEndTime = Math.floor(Date.now() / 1000) + PHASE_DURATIONS.rps;
            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                {
                    $set: {
                        status: 'playing',
                        phase: 'rps',
                        phase_end_time: phaseEndTime,
                        updated_at: new Date()
                    }
                }
            );

            // FIX: bots pick their RPS choice immediately when game starts
            await botPickRPS(lobby_id, db);
            await pusher.trigger(`game-${lobby_id}`, 'game-started', {});
            return res.json({ success: true });
        }

        if (action === 'resolve_rps') {
            const { lobby_id } = req.body;
            if (!lobby_id) return res.json({ error: 'Lobby ID required' });

            const result = await resolveRPSPhase(lobby_id, db);
            return res.json(result);
        }

        if (action === 'rps_choice') {
            const { lobby_id, uid, choice } = req.body;
            if (!lobby_id || !uid || !choice) return res.json({ error: 'Missing parameters' });
            if (!['rock', 'paper', 'scissors'].includes(choice)) {
                return res.json({ error: 'Invalid choice' });
            }

            const result = await db.collection('lobbies').updateOne(
                { _id: lobby_id, 'players.uid': uid, 'players.is_dead': false },
                {
                    $set: {
                        'players.$.rps_choice': choice,
                        updated_at: new Date()
                    }
                }
            );

            if (result.matchedCount === 0) {
                return res.json({ error: 'Player not found or dead' });
            }

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (lobby && lobby.phase === 'rps') {
                const alivePlayers = lobby.players.filter(p => !p.is_dead);
                const allChose = alivePlayers.every(p => p.rps_choice !== null);

                debouncedStateUpdate(lobby_id);

                if (allChose) {
                    await resolveRPSPhase(lobby_id, db);
                }
            }

            return res.json({ success: true });
        }

        if (action === 'buy_item') {
            const { lobby_id, uid, item } = req.body;
            if (!lobby_id || !uid || !item) return res.json({ error: 'Missing parameters' });

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });

            const player = lobby.players.find(p => p.uid === uid);
            if (!player || player.is_dead) return res.json({ error: 'Invalid player' });
            if (lobby.phase !== 'coin') return res.json({ error: 'Not coin phase' });

            const itemData = SHOP_ITEMS[item];
            if (!itemData) return res.json({ error: 'Invalid item' });
            if (player.coins < itemData.cost) return res.json({ error: 'Not enough coins' });
            if (player[item] >= itemData.max) return res.json({ error: 'Max items reached' });

            await db.collection('lobbies').updateOne(
                { _id: lobby_id, 'players.uid': uid },
                {
                    $inc: {
                        'players.$.coins': -itemData.cost,
                        [`players.$.${item}`]: 1
                    },
                    $set: { updated_at: new Date() }
                }
            );

            debouncedStateUpdate(lobby_id);
            await checkAllCoinsZero(lobby_id, db);

            setTimeout(() => botTurn(lobby_id, db), 500);

            return res.json({ success: true });
        }

        if (action === 'use_item') {
            const { lobby_id, uid, item, target_uid } = req.body;
            if (!lobby_id || !uid || !item || !target_uid) {
                return res.json({ error: 'Missing parameters' });
            }

            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });

            const player = lobby.players.find(p => p.uid === uid);
            const target = lobby.players.find(p => p.uid === target_uid);

            if (!player || !target || player.is_dead || target.is_dead) {
                return res.json({ error: 'Invalid players' });
            }
            if (lobby.phase !== 'coin') return res.json({ error: 'Not coin phase' });
            if (player[item] <= 0) return res.json({ error: 'No items' });

            // FIX: Use separate atomic updates instead of arrayFilters to avoid multi-filter conflicts
            // Decrement attacker's item
            await db.collection('lobbies').updateOne(
                { _id: lobby_id, 'players.uid': uid },
                {
                    $inc: { [`players.$.${item}`]: -1 },
                    $set: { updated_at: new Date() }
                }
            );

            if (item === 'canon') {
                if (target.shields > 0) {
                    // Canon destroys a shield
                    await db.collection('lobbies').updateOne(
                        { _id: lobby_id, 'players.uid': target_uid },
                        {
                            $inc: { 'players.$.shields': -1 },
                            $set: { updated_at: new Date() }
                        }
                    );
                }
                // If no shields, canon does nothing (by design)
            } else if (item === 'slicer') {
                if (target.shields === 0) {
                    const newHealth = Math.max(0, target.health - 1);
                    const isDead = newHealth === 0;
                    await db.collection('lobbies').updateOne(
                        { _id: lobby_id, 'players.uid': target_uid },
                        {
                            $set: {
                                'players.$.health': newHealth,
                                'players.$.is_dead': isDead,
                                updated_at: new Date()
                            }
                        }
                    );
                }
                // Slicer blocked by shields — does nothing
            }

            const updatedLobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            const alivePlayers = updatedLobby.players.filter(p => !p.is_dead);

            if (alivePlayers.length === 1) {
                await db.collection('lobbies').updateOne(
                    { _id: lobby_id },
                    { $set: { status: 'finished', phase: 'finished', updated_at: new Date() } }
                );
                await pusher.trigger(`game-${lobby_id}`, 'game-ended', { winner: alivePlayers[0] });
            } else {
                debouncedStateUpdate(lobby_id);
                await checkAllCoinsZero(lobby_id, db);
            }

            return res.json({ success: true });
        }

        if (action === 'batch_update') {
            // Batch update endpoint to reduce multiple API calls
            const { lobby_id, updates } = req.body;
            if (!lobby_id || !Array.isArray(updates)) {
                return res.json({ error: 'Invalid batch request' });
            }

            const bulkOps = [];
            for (const update of updates) {
                const { uid, field, value } = update;
                if (!uid || !field) continue;

                bulkOps.push({
                    updateOne: {
                        filter: { _id: lobby_id, 'players.uid': uid },
                        update: { $set: { [`players.$.${field}`]: value, updated_at: new Date() } }
                    }
                });
            }

            if (bulkOps.length > 0) {
                await db.collection('lobbies').bulkWrite(bulkOps);
                debouncedStateUpdate(lobby_id);
            }

            return res.json({ success: true });
        }

        if (action === 'next_round') {
            const { lobby_id } = req.body;
            if (!lobby_id) return res.json({ error: 'Lobby ID required' });
            await startNextRound(lobby_id, db);
            return res.json({ success: true });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: error.message || 'Server error' });
    }
};
