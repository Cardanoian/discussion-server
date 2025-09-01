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
    console.log('Supabase 연결 테스트 중...');
    const { error } = await supabase.from('subjects').select('count');
    if (error) {
      console.error('Supabase 연결 오류:', error);
    } else {
      console.log('Supabase 연결 성공');

      // Test subjects table specifically
      const { data: subjects, error: subjectsError } = await supabase
        .from('subjects')
        .select('*');
      if (subjectsError) {
        console.error('subjects 테이블 쿼리 오류:', subjectsError);
      } else {
        console.log(
          `데이터베이스에서 ${subjects?.length || 0}개의 주제를 찾았습니다.`
        );
        if (subjects && subjects.length > 0) {
          console.log('샘플 주제:', subjects[0]);
        }
      }
    }
  } catch (err) {
    console.error('Supabase 연결 테스트 실패:', err);
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
  console.log(`새 클라이언트 연결됨: ${socket.id}`);

  registerRoomHandlers(io, socket);
  registerBattleHandlers(io, socket);

  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 해제됨: ${socket.id}`);
    // Handle cleanup when a user disconnects, e.g., leave rooms
  });
};

io.on('connection', onConnection);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () =>
  console.log(`서버가 포트 ${PORT}에서 수신 중입니다.`)
);
