import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { registerRoomHandlers } from './socket/roomHandlers';
import { registerBattleHandlers } from './socket/battleHandlers';
import { supabase } from './supabaseClient';

dotenv.config();

// Test Supabase connection on startup
const testSupabaseConnection = async () => {
  try {
    console.log('Testing Supabase connection...');
    const { error } = await supabase.from('subjects').select('count');
    if (error) {
      console.error('Supabase connection error:', error);
    } else {
      console.log('Supabase connection successful');

      // Test subjects table specifically
      const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('*');
      if (subjectsError) {
        console.error('Error querying subjects table:', subjectsError);
      } else {
        console.log(`Found ${subjects?.length || 0} subjects in database`);
        if (subjects && subjects.length > 0) {
          console.log('Sample subject:', subjects[0]);
        }
      }
    }
  } catch (err) {
    console.error('Supabase connection test failed:', err);
  }
};

testSupabaseConnection();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // In production, you should restrict this to your frontend's URL
    methods: ['GET', 'POST'],
  },
});

const onConnection = (socket: Socket) => {
  console.log(`New client connected: ${socket.id}`);

  registerRoomHandlers(io, socket);
  registerBattleHandlers(io, socket);

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    // Handle cleanup when a user disconnects, e.g., leave rooms
  });
};

io.on('connection', onConnection);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
