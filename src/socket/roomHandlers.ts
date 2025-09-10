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
    uuid: '09ea24c8-e079-4c9b-98c4-f9f4d983fd72',
    title: '용돈을 꼭 받아야 할까?',
    text: ' 부모님께 용돈을 받는 것의 필요성에 대해 이야기해보세요. 용돈을 관리하는 좋은 방법은 무엇일까요?',
  },
  {
    uuid: '137c81c5-2d51-477d-a5ba-3d2e6d17b5bd',
    title: '인공지능은 우리에게 위협이 될까?',
    text: ' 인공지능이 발전하는 미래 사회의 모습에 대해 상상하며 인공지능과 함께 살아갈 방법에 대해 토론해보세요.',
  },
  {
    uuid: '72d20aaf-56e1-432f-b430-bdb7aa805081',
    title: '선의의 거짓말은 해도 될까?',
    text: ' 다른 사람을 기분 좋게 하거나 상처주지 않기 위해 하는 거짓말은 허용될 수 있는지에 대해 토론해보세요.',
  },
  {
    uuid: '7a2f7968-1aaf-4b0d-bf64-8723c5053c9a',
    title: '유행을 꼭 따라야 할까?',
    text: ' 친구들 사이에서 유행하는 옷이나 물건을 꼭 따라 사야 하는지에 대해 토론해보세요. 나만의 개성을 지키는 것의 중요성에 대해 이야기해봅시다.',
  },
  {
    uuid: 'b8767bff-c632-44ee-a3d8-46e349d6e0c6',
    title: '일기 쓰기는 꼭 필요한 습관일까?',
    text: ' 매일 일기를 쓰는 것의 장점과 단점에 대해 자유롭게 이야기해보세요. 일기 쓰기가 우리에게 어떤 도움을 줄 수 있을까요?',
  },
];
