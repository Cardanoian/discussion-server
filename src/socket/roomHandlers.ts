import { Server, Socket } from 'socket.io';
import { BattleRoom, Subject } from '../types/database';
import { supabase } from '../supabaseClient';
import { startBattleLogic } from './battleHandlers';
import { requestManager } from '../utils/RequestManager';

const rooms: BattleRoom[] = [];

const createRoom = (roomId: string, subject: Subject): BattleRoom => ({
  roomId,
  subject,
  players: [],
  isFull: false,
  battleStarted: false,
});

export const registerRoomHandlers = (io: Server, socket: Socket) => {
  // 소켓 연결 해제 시 요청 상태 정리
  socket.on('disconnect', () => {
    requestManager.cleanup(socket.id);
  });

  socket.on('get_subjects', async (callback) => {
    // console.log('데이터베이스에서 주제를 가져오는 중...');

    // Try database first, fallback to hardcoded data if it fails
    try {
      const { data, error } = await supabase.from('subjects').select('*');
      // console.log('주제 쿼리 결과:', { data, error });

      if (error) {
        console.error('주제 가져오기 오류:', error);
        // console.log('대체 하드코딩된 주제를 사용합니다...');

        // console.log('클라이언트에 대체 주제를 전송합니다:', fallbackSubjects);
        callback({ subjects: fallbackSubjects });
        return;
      }

      // console.log('클라이언트에 주제를 전송합니다:', data);
      callback({ subjects: data });
    } catch (err) {
      console.error('데이터베이스 연결 실패, 대체 주제를 사용합니다:', err);

      // console.log('Sending fallback subjects to client:', fallbackSubjects);
      callback({ subjects: fallbackSubjects });
    }
  });

  socket.on(
    'create_room',
    async (
      { userId, subjectId }: { userId: string; subjectId: string },
      callback
    ) => {
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'create_room')) {
        callback({ error: '이미 방 생성 요청을 처리 중입니다.' });
        return;
      }

      const roomId = `room_${new Date().getTime()}`;

      try {
        // 주제 정보 가져오기
        const { data: subjectData, error: subjectError } = await supabase
          .from('subjects')
          .select('*')
          .eq('uuid', subjectId)
          .single();

        if (subjectError || !subjectData) {
          requestManager.finishProcessing(socket.id, 'create_room');
          callback({ error: '주제를 찾을 수 없습니다.' });
          return;
        }

        // 사용자 정보 가져오기
        const { data: userData, error: userError } = await supabase
          .from('user_profile')
          .select('*')
          .eq('user_uuid', userId)
          .maybeSingle();

        if (userError || !userData) {
          requestManager.finishProcessing(socket.id, 'create_room');
          callback({ error: '사용자 정보를 찾을 수 없습니다.' });
          return;
        }

        const newRoom = createRoom(roomId, subjectData);
        newRoom.players.push({
          socketId: socket.id,
          userId,
          displayname: userData.display_name,
          isReady: false,
          rating: userData.rating,
          wins: userData.wins,
          loses: userData.loses,
        });
        rooms.push(newRoom);
        socket.join(roomId);
        callback({ room: newRoom });
        io.emit(
          'rooms_update',
          rooms.filter((r) => !r.isFull && !r.battleStarted)
        );
        // console.log(newRoom);
      } catch (error) {
        console.error('방 생성 오류:', error);
        callback({ error: '방 생성 중 오류가 발생했습니다.' });
      } finally {
        requestManager.finishProcessing(socket.id, 'create_room');
      }
    }
  );

  socket.on(
    'join_room',
    async (
      { roomId, userId }: { roomId: string; userId: string },
      callback
    ) => {
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'join_room')) {
        callback({ error: '이미 방 참가 요청을 처리 중입니다.' });
        return;
      }

      const room = rooms.find((r) => r.roomId === roomId);
      if (room && !room.isFull) {
        try {
          // 사용자 정보 가져오기
          const { data: userData, error: userError } = await supabase
            .from('user_profile')
            .select('*')
            .eq('user_uuid', userId)
            .maybeSingle();

          if (userError || !userData) {
            requestManager.finishProcessing(socket.id, 'join_room');
            callback({ error: '사용자 정보를 찾을 수 없습니다.' });
            return;
          }

          room.players.push({
            socketId: socket.id,
            userId,
            displayname: userData.display_name,
            isReady: false,
            rating: userData.rating,
            wins: userData.wins,
            loses: userData.loses,
          });
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
        } catch (error) {
          console.error('방 참가 오류:', error);
          callback({ error: '방 참가 중 오류가 발생했습니다.' });
        } finally {
          requestManager.finishProcessing(socket.id, 'join_room');
        }
      } else {
        requestManager.finishProcessing(socket.id, 'join_room');
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
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'player_ready')) {
        return;
      }

      try {
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
      } finally {
        requestManager.finishProcessing(socket.id, 'player_ready');
      }
    }
  );

  socket.on(
    'select_position',
    ({
      roomId,
      userId,
      position,
    }: {
      roomId: string;
      userId: string;
      position: 'agree' | 'disagree';
    }) => {
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'select_position')) {
        return;
      }

      try {
        const room = rooms.find((r) => r.roomId === roomId);
        if (room) {
          const player = room.players.find((p) => p.userId === userId);
          if (player) {
            player.position = position;
            io.to(roomId).emit('room_update', room);

            // 클라이언트에 입장 선택 확인 전송
            socket.emit('position_selected', { position });
          }
        }
      } finally {
        requestManager.finishProcessing(socket.id, 'select_position');
      }
    }
  );

  socket.on(
    'join_discussion_room',
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      // console.log(`${userId}가 토론 룸 ${roomId}에 join 시도`);
      const room = rooms.find((r) => r.roomId === roomId);
      if (room) {
        const player = room.players.find((p) => p.userId === userId);
        if (player) {
          // 플레이어의 소켓 ID를 현재 소켓으로 업데이트
          player.socketId = socket.id;
          socket.join(roomId);
          console.log(
            `${player.displayname}이 토론 룸에 join 완료, 새 소켓 ID: ${socket.id}`
          );
        }
      }
    }
  );

  socket.on(
    'discussion_view_ready',
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.find((r) => r.roomId === roomId);
      if (room && room.battleStarted) {
        const player = room.players.find((p) => p.userId === userId);
        if (player) {
          // 플레이어를 discussionView 준비 완료로 표시
          player.discussionViewReady = true;
          // console.log(`${player.displayname}이 discussionView 준비 완료`);

          // 두 플레이어 모두 준비되었는지 확인
          const allPlayersReady = room.players.every(
            (p) => p.discussionViewReady
          );

          if (allPlayersReady) {
            // console.log('모든 플레이어가 discussionView 준비 완료, 토론 시작');
            // battleHandlers의 통합된 토론 시작 로직 사용
            startBattleLogic(io, room);
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
