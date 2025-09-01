import { Server, Socket } from 'socket.io';
import { BattleRoom, Subject } from '../types/database';
import { supabase } from '../supabaseClient';

const rooms: BattleRoom[] = [];

const createRoom = (roomId: string, subject: Subject): BattleRoom => ({
  roomId,
  subject,
  players: [],
  isFull: false,
  battleStarted: false,
});

export const registerRoomHandlers = (io: Server, socket: Socket) => {
  socket.on('get_subjects', async (callback) => {
    console.log('데이터베이스에서 주제를 가져오는 중...');

    // Try database first, fallback to hardcoded data if it fails
    try {
      const { data, error } = await supabase.from('subjects').select('*');
      console.log('주제 쿼리 결과:', { data, error });

      if (error) {
        console.error('주제 가져오기 오류:', error);
        console.log('대체 하드코딩된 주제를 사용합니다...');

        console.log('클라이언트에 대체 주제를 전송합니다:', fallbackSubjects);
        callback({ subjects: fallbackSubjects });
        return;
      }

      console.log('클라이언트에 주제를 전송합니다:', data);
      callback({ subjects: data });
    } catch (err) {
      console.error('데이터베이스 연결 실패, 대체 주제를 사용합니다:', err);

      // console.log('Sending fallback subjects to client:', fallbackSubjects);
      callback({ subjects: fallbackSubjects });
    }
  });

  socket.on(
    'create_room',
    (
      { userId, subjectId }: { userId: string; subjectId: string },
      callback
    ) => {
      const roomId = `room_${new Date().getTime()}`;

      supabase
        .from('subjects')
        .select('*')
        .eq('uuid', subjectId)
        .single()
        .then(({ data, error }) => {
          if (error || !data) {
            callback({ error: '주제를 찾을 수 없습니다.' });
            return;
          }
          const newRoom = createRoom(roomId, data);
          newRoom.players.push({ socketId: socket.id, userId, isReady: false });
          rooms.push(newRoom);
          socket.join(roomId);
          callback({ room: newRoom });
          io.emit(
            'rooms_update',
            rooms.filter((r) => !r.isFull && !r.battleStarted)
          );
        });
    }
  );

  socket.on(
    'join_room',
    ({ roomId, userId }: { roomId: string; userId: string }, callback) => {
      const room = rooms.find((r) => r.roomId === roomId);
      if (room && !room.isFull) {
        room.players.push({ socketId: socket.id, userId, isReady: false });
        socket.join(roomId);
        if (room.players.length === 2) {
          room.isFull = true;
        }
        callback({ room });
        io.to(roomId).emit('room_update', room);
        io.emit(
          'rooms_update',
          rooms.filter((r) => !r.isFull && !r.battleStarted)
        );
      } else {
        callback({ error: '방을 찾을 수 없거나 가득 찼습니다.' });
      }
    }
  );

  socket.on('get_rooms', (callback) => {
    callback({ rooms: rooms.filter((r) => !r.isFull && !r.battleStarted) });
  });

  socket.on(
    'player_ready',
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.find((r) => r.roomId === roomId);
      if (room) {
        const player = room.players.find((p) => p.userId === userId);
        if (player) {
          player.isReady = !player.isReady;
          io.to(roomId).emit('room_update', room);

          if (
            room.players.length === 2 &&
            room.players.every((p) => p.isReady)
          ) {
            room.battleStarted = true;
            io.to(roomId).emit('battle_start', room);
            io.emit(
              'rooms_update',
              rooms.filter((r) => !r.isFull && !r.battleStarted)
            );
          }
        }
      }
    }
  );

  socket.on(
    'leave_room',
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      const roomIndex = rooms.findIndex((r) => r.roomId === roomId);
      if (roomIndex !== -1) {
        const room = rooms[roomIndex];
        room.players = room.players.filter((p) => p.userId !== userId);
        socket.leave(roomId);

        if (room.players.length === 0) {
          rooms.splice(roomIndex, 1);
        } else {
          room.isFull = false;
          room.players.forEach((p) => (p.isReady = false));
          io.to(roomId).emit('room_update', room);
        }
        io.emit(
          'rooms_update',
          rooms.filter((r) => !r.isFull && !r.battleStarted)
        );
      }
    }
  );
};

// Fallback hardcoded subjects
const fallbackSubjects = [
  {
    uuid: '1',
    title: '인공지능이 인간의 일자리를 대체할 것인가?',
    text: '인공지능 기술의 발전으로 많은 직업이 자동화될 가능성이 높아지고 있습니다.',
  },
  {
    uuid: '2',
    title: '원격근무가 사무실 근무보다 효율적인가?',
    text: '코로나19 이후 원격근무가 일반화되었습니다. 원격근무와 사무실 근무의 장단점을 비교해보세요.',
  },
  {
    uuid: '3',
    title: '소셜미디어가 사회에 미치는 영향은 긍정적인가?',
    text: '소셜미디어는 현대 사회의 필수 요소가 되었습니다. 그 영향이 긍정적인지 부정적인지 토론해보세요.',
  },
  {
    uuid: '4',
    title: '기본소득제도가 필요한가?',
    text: '모든 국민에게 조건 없이 일정 금액을 지급하는 기본소득제도에 대해 토론해보세요.',
  },
  {
    uuid: '5',
    title: '전기차가 환경에 정말 도움이 되는가?',
    text: '전기차의 환경적 영향에 대해 배터리 생산, 전력 생산 방식 등을 고려하여 토론해보세요.',
  },
];
