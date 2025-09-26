import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { registerRoomHandlers } from './socket/roomHandlers';
import { registerBattleHandlers } from './socket/battleHandlers';
import { supabase } from './supabaseClient';
import geminiRouter from './routes/gemini';

dotenv.config();

// Test Supabase connection on startup
const testSupabaseConnection = async () => {
  try {
    // console.log('Supabase 연결 테스트 중...');
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
        //   if (subjects && subjects.length > 0) {
        //     console.log('샘플 주제:', subjects[0]);
        //   }
      }
    }
  } catch (err) {
    console.error('Supabase 연결 테스트 실패:', err);
  }
};

testSupabaseConnection();

const app = express();

// CORS 설정 개선
const corsOptions = {
  origin:
    // process.env.NODE_ENV === 'production'
    //   ? process.env.FRONTEND_URL || 'https://your-frontend-domain.com'
    //   :
    [
      'http://129.154.48.207/',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
      'https://ai-dis.netlify.app',
      process.env.FRONTEND_URL ?? 'https://gbeai.net',
    ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

app.use(cors(corsOptions));
app.use(express.json());

// API 라우터 연결
app.use('/api/gemini', geminiRouter);

// 기본 라우트 추가
app.get('/', (req, res) => {
  res.json({
    message: 'Discussion Server is running!',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Health check 엔드포인트
app.get('/health', (req, res) => {
  res.json({ status: 'OK', uptime: process.uptime() });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions,
});

const onConnection = (socket: Socket) => {
  console.log(`새 클라이언트 연결됨: ${socket.id}`);

  registerRoomHandlers(io, socket);
  registerBattleHandlers(io, socket);

  // console.log(`소켓 ${socket.id}에 핸들러 등록 완료`);

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
