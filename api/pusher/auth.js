import Pusher from 'pusher';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: "52d629612765e85a5546",
  secret: process.env.PUSHER_SECRET,
  cluster: "ap2",
  useTLS: true
});

export default async function handler(req, res) {
  const { socket_id, channel_name } = req.body;
  const userData = JSON.parse(req.body.user_info || '{}');
  
  const presenceData = {
    user_id: userData.user_id,
    user_info: { username: userData.username }
  };
  
  const auth = pusher.authorizeChannel(socket_id, channel_name, presenceData);
  res.send(auth);
}
