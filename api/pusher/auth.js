const Pusher = require('pusher');

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: '52d629612765e85a5546',
  secret: process.env.PUSHER_SECRET,
  cluster: 'ap2',
  useTLS: true
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { socket_id, channel_name } = req.body;

    if (!socket_id || !channel_name) {
      return res.status(400).json({ error: 'Missing socket_id or channel_name' });
    }

    let userData = { user_id: socket_id, username: 'Guest' };

    if (req.body.user_info) {
      try {
        const parsed = JSON.parse(req.body.user_info);
        userData = {
          user_id: parsed.user_id || socket_id,
          username: parsed.username || 'Guest'
        };
      } catch (e) {
        console.log('Parse user_info failed:', e);
      }
    }

    const presenceData = {
      user_id: userData.user_id,
      user_info: {
        username: userData.username
      }
    };

    const auth = pusher.authorizeChannel(socket_id, channel_name, presenceData);
    return res.status(200).send(auth);

  } catch (error) {
    console.error('Pusher auth error:', error);
    return res.status(500).json({ error: 'Auth failed', message: error.message });
  }
};
