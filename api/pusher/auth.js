import Pusher from 'pusher';

export const config = {
  api: {
    bodyParser: true, // මේක අනිවාර්යයි Vercel එකේ
  },
};

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: "52d629612765e85a5546",
  secret: process.env.PUSHER_SECRET,
  cluster: "ap2",
  useTLS: true
});

export default async function handler(req, res) {
  // CORS headers දාන්න
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { socket_id, channel_name } = req.body;
    
    // user_info parse කරන්න
    let userData = {};
    if (req.body.user_info) {
      userData = JSON.parse(req.body.user_info);
    }

    const presenceData = {
      user_id: userData.user_id || socket_id,
      user_info: { 
        username: userData.username || 'Guest'
      }
    };
    
    const auth = pusher.authorizeChannel(socket_id, channel_name, presenceData);
    res.send(auth);
    
  } catch (error) {
    console.error('Pusher auth error:', error);
    res.status(500).json({ error: error.message });
  }
}
