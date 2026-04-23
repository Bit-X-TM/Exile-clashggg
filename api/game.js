const { MongoClient } = require('mongodb');
const Pusher = require('pusher');

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
    const client = await MongoClient.connect(process.env.MONGODB_URI);
    const db = client.db('exile_clash');
    cachedClient = client;
    cachedDb = db;
    return { client, db };
}

const pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID,
    key: '52d629612765e85a5546',
    secret: process.env.PUSHER_SECRET,
    cluster: 'ap2',
    useTLS: true
});

const SHOP_ITEMS = {
    shields: { cost: 1, max: 3 },
    canon: { cost: 1, max: 3 },
    slicer: { cost: 1, max: 3 }
};

const PHASE_DURATIONS = { rps: 15, coin: 20 };

async function cleanupInactiveLobbies(db) {
    const now = Date.now();
    const oneMinAgo = new Date(now - 60 * 1000);
    const thirtyMinAgo = new Date(now - 30 * 60 * 1000);
    const fiveMinAgo = new Date(now - 5 * 60 * 1000);

    const result = await db.collection('lobbies').deleteMany({
        $or: [
            { status: 'waiting', players: { $size: 1 }, updated_at: { $lt: oneMinAgo } },
            { status: 'playing', updated_at: { $lt: thirtyMinAgo } },
            { status: 'finished', updated_at: { $lt: fiveMinAgo } }
        ]
    });
    if (result.deletedCount > 0) {
        console.log(`Deleted ${result.deletedCount} inactive lobbies`);
    }
}

async function checkAllCoinsZero(lobbyId, db) {
    const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
    if (!lobby || lobby.phase!== 'coin') return;

    const alivePlayers = lobby.players.filter(p =>!p.is_dead);
    const allZero = alivePlayers.every(p => p.coins === 0 && p.canon === 0 && p.slicer === 0);

    if (allZero && alivePlayers.length > 1) {
        await startNextRound(lobbyId, db);
    }
}

async function startNextRound(lobbyId, db) {
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

    await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
}

async function resolveRPSPhase(lobbyId, db) {
    const lobby = await db.collection('lobbies').findOne({ _id: lobbyId });
    if (!lobby || lobby.phase!== 'rps') return { error: 'Not RPS phase' };

    const alivePlayers = lobby.players.filter(p =>!p.is_dead);
    const choices = ['rock', 'paper', 'scissors'];

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
    const players = updatedLobby.players.filter(p =>!p.is_dead);

    for (let i = 0; i < players.length; i++) {
        let wins = 0;
        const p1 = players[i];

        for (let j = 0; j < players.length; j++) {
            if (i === j) continue;
            const p2 = players[j];

            if (
                (p1.rps_choice === 'rock' && p2.rps_choice === 'scissors') ||
                (p1.rps_choice === 'paper' && p2.rps_choice === 'rock') ||
                (p1.rps_choice === 'scissors' && p2.rps_choice === 'paper')
            ) {
                wins++;
            }
        }

        let result = 'DRAW';
        if (wins > players.length / 2) result = 'WIN';
        else if (wins < players.length / 2 - 1) result = 'LOSE';

        await db.collection('lobbies').updateOne(
            { _id: lobbyId, 'players.uid': p1.uid },
            {
                $set: {
                    'players.$.rps_result': result,
                    'players.$.coins': wins
                }
            }
        );
    }

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
    setTimeout(() => checkAllCoinsZero(lobbyId, db), 1000);
    return { success: true };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { db } = await connectToDatabase();
        await cleanupInactiveLobbies(db);

        const { action } = req.method === 'GET'? req.query : req.body;

        if (action === 'admin_login') {
            const { username, password } = req.body;
            if (username === 'Nethindu' && password === '1234') {
                return res.json({ success: true, token: 'admin_token_exile_1234' });
            }
            return res.json({ error: 'Invalid credentials' });
        }

        if (action === 'delete_lobby') {
            const { lobby_id, admin_token } = req.body;
            if (admin_token!== 'admin_token_exile_1234') {
                return res.json({ error: 'Unauthorized' });
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
            if (admin_token!== 'admin_token_exile_1234') {
                return res.json({ error: 'Unauthorized' });
            }
            const lobbies = await db.collection('lobbies')
             .find({})
             .sort({ created_at: -1 })
             .limit(50)
             .toArray();
            return res.json({ lobbies });
        }

        if (action === 'create_lobby') {
            const { uid, name, is_public, player_name } = req.body;
            const now = new Date();

            const existingLobby = await db.collection('lobbies').findOne({
                name: name || 'Exile Clash',
                status: { $in: ['waiting', 'playing'] }
            });

            if (existingLobby) {
                return res.json({ error: 'Lobby name already taken! Choose another name 🐻' });
            }

            const lobbyId = Math.random().toString(36).substring(2, 8).toUpperCase();

            const lobby = {
                _id: lobbyId,
                name: name || 'Exile Clash',
                is_public: is_public || 0,
                host_uid: uid,
                status: 'waiting',
                phase: 'lobby',
                players: [{
                    uid,
                    name: player_name || 'Player',
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
            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });

            if (!lobby) return res.json({ error: 'Lobby not found' });
            if (lobby.status!== 'waiting') return res.json({ error: 'Game already started' });
            if (lobby.players.length >= 6) return res.json({ error: 'Lobby full' });
            if (lobby.players.find(p => p.uid === uid)) return res.json({ success: true });

            const now = new Date();
            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                {
                    $push: {
                        players: {
                            uid,
                            name: player_name || 'Player',
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

            await pusher.trigger(`game-${lobby_id}`, 'state-update', {});
            return res.json({ success: true });
        }

        if (action === 'get_state') {
            const { lobby_id } = req.body;
            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            if (!lobby) return res.json({ error: 'Lobby not found' });

            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                { $set: { updated_at: new Date() } }
            );

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

            await pusher.trigger(`game-${lobby_id}`, 'game-started', {});
            return res.json({ success: true });
        }

        if (action === 'resolve_rps') {
            const { lobby_id } = req.body;
            const result = await resolveRPSPhase(lobby_id, db);
            return res.json(result);
        }

        if (action === 'rps_choice') {
            const { lobby_id, uid, choice } = req.body;
            if (!['rock', 'paper', 'scissors'].includes(choice)) {
                return res.json({ error: 'Invalid choice' });
            }

            await db.collection('lobbies').updateOne(
                { _id: lobby_id, 'players.uid': uid },
                {
                    $set: {
                        'players.$.rps_choice': choice,
                        updated_at: new Date()
                    }
                }
            );

            await pusher.trigger(`game-${lobby_id}`, 'state-update', {});
            return res.json({ success: true });
        }

        if (action === 'buy_item') {
            const { lobby_id, uid, item } = req.body;
            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            const player = lobby.players.find(p => p.uid === uid);

            if (!player || player.is_dead) return res.json({ error: 'Invalid player' });
            if (lobby.phase!== 'coin') return res.json({ error: 'Not coin phase' });

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

            await pusher.trigger(`game-${lobby_id}`, 'state-update', {});
            await checkAllCoinsZero(lobby_id, db);
            return res.json({ success: true });
        }

        if (action === 'use_item') {
            const { lobby_id, uid, item, target_uid } = req.body;
            const lobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            const player = lobby.players.find(p => p.uid === uid);
            const target = lobby.players.find(p => p.uid === target_uid);

            if (!player ||!target || player.is_dead || target.is_dead) {
                return res.json({ error: 'Invalid players' });
            }
            if (lobby.phase!== 'coin') return res.json({ error: 'Not coin phase' });
            if (player[item] <= 0) return res.json({ error: 'No items' });

            let updates = { $inc: { [`players.$[p].${item}`]: -1 }, $set: { updated_at: new Date() } };
            let arrayFilters = [{ 'p.uid': uid }];

            if (item === 'canon') {
                if (target.shields > 0) {
                    updates.$inc['players.$[t].shields'] = -1;
                    arrayFilters.push({ 't.uid': target_uid });
                }
            } else if (item === 'slicer') {
                if (target.shields === 0) {
                    const newHealth = Math.max(0, target.health - 1);
                    updates.$set['players.$[t].health'] = newHealth;
                    if (newHealth === 0) updates.$set['players.$[t].is_dead'] = true;
                    arrayFilters.push({ 't.uid': target_uid });
                }
            }

            await db.collection('lobbies').updateOne(
                { _id: lobby_id },
                updates,
                { arrayFilters }
            );

            const updatedLobby = await db.collection('lobbies').findOne({ _id: lobby_id });
            const alivePlayers = updatedLobby.players.filter(p =>!p.is_dead);

            if (alivePlayers.length === 1) {
                await db.collection('lobbies').updateOne(
                    { _id: lobby_id },
                    { $set: { status: 'finished', phase: 'finished', updated_at: new Date() } }
                );
                await pusher.trigger(`game-${lobby_id}`, 'game-ended', { winner: alivePlayers[0] });
            } else {
                await pusher.trigger(`game-${lobby_id}`, 'state-update', {});
                await checkAllCoinsZero(lobby_id, db);
            }

            return res.json({ success: true });
        }

        if (action === 'next_round') {
            const { lobby_id } = req.body;
            await startNextRound(lobby_id, db);
            return res.json({ success: true });
        }

        return res.json({ error: 'Invalid action' });

    } catch (error) {
        console.error('API Error:', error);
        return res.json({ error: 'Server error' });
    }
};
