import { MongoClient } from 'mongodb';
import Pusher from 'pusher';

const client = new MongoClient(process.env.MONGODB_URI);
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: "52d629612765e85a5546",
  secret: process.env.PUSHER_SECRET,
  cluster: "ap2",
  useTLS: true
});

let cachedDb = null;
async function connectDB() {
  if (cachedDb) return cachedDb;
  await client.connect();
  cachedDb = client.db('exile_clash');
  return cachedDb;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.method === 'POST'? req.body.action : req.query.action;
  const lobbyId = req.method === 'POST'? req.body.lobby_id : req.query.lobby_id;

  const db = await connectDB();
  const lobbies = db.collection('lobbies');

  try {
    switch(action) {
      case 'create_lobby': {
        const { uid, name, is_public, player_name } = req.body;
        const id = Math.random().toString(36).substring(2, 8).toUpperCase();
        const island = Math.floor(Math.random() * 6) + 1;

        const lobby = {
          _id: id,
          name: name || 'Exile Clash',
          is_public: is_public?? 1,
          host_uid: uid,
          status: 'waiting',
          phase: 'rps',
          phase_end_time: 0,
          round: 0,
          created_at: new Date(),
          players: [{
            uid, name: player_name, island,
            coins: 0, shields: 0, health: 4,
            canon: 0, slicer: 0, rps_choice: null,
            rps_result: null, is_dead: false,
            joined_at: new Date()
          }]
        };

        await lobbies.insertOne(lobby);
        return res.json({ success: true, lobby_id: id });
      }

      case 'join_lobby': {
        const { uid, player_name } = req.body;
        const lobby = await lobbies.findOne({ _id: lobbyId });

        if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
        if (lobby.status!== 'waiting') return res.status(400).json({ error: 'Game already started' });
        if (lobby.players.length >= 6) return res.status(400).json({ error: 'Lobby full' });
        if (lobby.players.find(p => p.uid === uid)) {
          return res.json({ success: true }); // Already joined
        }

        const taken = lobby.players.map(p => p.island);
        const available = [1,2,3,4,5,6].filter(i =>!taken.includes(i));
        const island = available[Math.floor(Math.random() * available.length)];

        await lobbies.updateOne(
          { _id: lobbyId },
          { $push: { players: {
            uid, name: player_name, island,
            coins: 0, shields: 0, health: 4,
            canon: 0, slicer: 0, rps_choice: null,
            rps_result: null, is_dead: false,
            joined_at: new Date()
          }}}
        );

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        return res.json({ success: true });
      }

      case 'start_game': {
        const lobby = await lobbies.findOne({ _id: lobbyId });
        if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
        if (lobby.players.length < 2) return res.status(400).json({ error: 'Need 2+ players' });

        await lobbies.updateOne(
          { _id: lobbyId },
          { $set: {
            status: 'playing',
            phase: 'rps',
            phase_end_time: Math.floor(Date.now()/1000) + 15,
            round: 1
          }}
        );
        await pusher.trigger(`game-${lobbyId}`, 'game-started', {});
        return res.json({ success: true });
      }

      case 'rps_choice': {
        const { uid, choice } = req.body;
        await lobbies.updateOne(
          { _id: lobbyId, 'players.uid': uid, 'players.is_dead': false },
          { $set: { 'players.$.rps_choice': choice }}
        );

        const lobby = await lobbies.findOne({ _id: lobbyId });
        const alive = lobby.players.filter(p =>!p.is_dead);
        const allChosen = alive.every(p => p.rps_choice!== null);

        if (allChosen && alive.length > 0) {
          const updates = [];
          const allSame = alive.every(p => p.rps_choice === alive[0].rps_choice);

          for (let p of alive) {
            let wins = 0;
            if (!allSame) {
              for (let opp of alive) {
                if (p.uid === opp.uid) continue;
                const c1 = p.rps_choice, c2 = opp.rps_choice;
                if ((c1=='rock'&&c2=='scissors')||(c1=='paper'&&c2=='rock')||(c1=='scissors'&&c2=='paper')) wins++;
              }
            }

            const result = allSame? 'DRAW - SKIP' : (wins > 0? `WIN +${wins}` : 'LOSE');
            const coinsToAdd = allSame? 0 : wins;

            updates.push({
              updateOne: {
                filter: { _id: lobbyId, 'players.uid': p.uid },
                update: {
                  $inc: { 'players.$.coins': coinsToAdd },
                  $set: { 'players.$.rps_result': result }
                }
              }
            });
          }

          if (updates.length) await lobbies.bulkWrite(updates);

          await lobbies.updateOne(
            { _id: lobbyId },
            { $set: {
              phase: 'coin',
              phase_end_time: Math.floor(Date.now()/1000) + 20,
              'players.$[].rps_choice': null // Reset for next round
            }}
          );
          await pusher.trigger(`game-${lobbyId}`, 'rps-resolved', {});
        }

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        return res.json({ success: true });
      }

      case 'buy_item': {
        const { uid, item } = req.body;
        if (!['canon', 'slicer', 'shields'].includes(item)) {
          return res.status(400).json({ error: 'Invalid item' });
        }

        const lobby = await lobbies.findOne({ _id: lobbyId, 'players.uid': uid });
        const p = lobby?.players.find(pl => pl.uid === uid);
        if (!p || p.is_dead) return res.status(400).json({ error: 'Player not found' });
        if (p.coins < 1) return res.status(400).json({ error: 'No coins' });
        if (p[item] >= 3) return res.status(400).json({ error: `Max ${item}s` });

        await lobbies.updateOne(
          { _id: lobbyId, 'players.uid': uid },
          { $inc: { 'players.$.coins': -1, [`players.$.${item}`]: 1 }}
        );

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        return res.json({ success: true });
      }

      case 'use_item': {
        const { uid, item, target_uid } = req.body;
        if (!['canon', 'slicer'].includes(item)) {
          return res.status(400).json({ error: 'Invalid item' });
        }

        const useResult = await lobbies.updateOne(
          { _id: lobbyId, 'players.uid': uid, 'players.is_dead': false, [`players.${item}`]: { $gte: 1 } },
          { $inc: { [`players.$.${item}`]: -1 }}
        );
        if (useResult.modifiedCount === 0) return res.status(400).json({ error: 'No item or dead' });

        if (item === 'canon') {
          await lobbies.updateOne(
            { _id: lobbyId, 'players.uid': target_uid, 'players.shields': { $gt: 0 }, 'players.is_dead': false },
            { $inc: { 'players.$.shields': -1 }}
          );
        } else if (item === 'slicer') {
          const targetResult = await lobbies.updateOne(
            { _id: lobbyId, 'players.uid': target_uid, 'players.shields': 0, 'players.is_dead': false },
            { $inc: { 'players.$.health': -1 }}
          );
          if (targetResult.modifiedCount > 0) {
            await lobbies.updateOne(
              { _id: lobbyId, 'players.uid': target_uid, 'players.health': { $lte: 0 } },
              { $set: { 'players.$.is_dead': true }}
            );
          }
        }

        const lobby = await lobbies.findOne({ _id: lobbyId });
        const alive = lobby.players.filter(pl =>!pl.is_dead);

        if (alive.length <= 1) {
          await lobbies.updateOne(
            { _id: lobbyId },
            { $set: { status: 'finished', phase: 'finished' }}
          );
          await pusher.trigger(`game-${lobbyId}`, 'game-ended', { winner: alive[0] || null });
        }

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        return res.json({ success: true });
      }

      case 'next_round': {
        const lobby = await lobbies.findOne({ _id: lobbyId });
        const alive = lobby.players.filter(p =>!p.is_dead);

        if (alive.length <= 1) {
          await lobbies.updateOne(
            { _id: lobbyId },
            { $set: { status: 'finished', phase: 'finished' }}
          );
          await pusher.trigger(`game-${lobbyId}`, 'game-ended', {});
          return res.json({ success: true, ended: true });
        }

        await lobbies.updateOne(
          { _id: lobbyId },
          { $set: {
            phase: 'rps',
            phase_end_time: Math.floor(Date.now()/1000) + 15,
            round: lobby.round + 1,
            'players.$[].rps_choice': null,
            'players.$[].rps_result': null
          }}
        );

        await pusher.trigger(`game-${lobbyId}`, 'state-update', {});
        return res.json({ success: true });
      }

      case 'get_state': {
        const lobby = await lobbies.findOne({ _id: lobbyId });
        if (!lobby) return res.status(404).json({ error: 'Lobby not found' });
        return res.json({ lobby, players: lobby.players });
      }

      case 'get_public_lobbies': {
        const publicLobbies = await lobbies.find({
          is_public: 1,
          status: 'waiting'
        }).limit(20).toArray();
        return res.json({ lobbies: publicLobbies });
      }

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (e) {
    console.error('API Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
