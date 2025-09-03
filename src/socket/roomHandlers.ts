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
    console.log('데이터베이스에서 주제를 가져오는 중...');

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
        console.log(newRoom);
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
      console.log(`${userId}가 토론 룸 ${roomId}에 join 시도`);
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
          console.log(`${player.displayname}이 discussionView 준비 완료`);

          // 두 플레이어 모두 준비되었는지 확인
          const allPlayersReady = room.players.every(
            (p) => p.discussionViewReady
          );

          if (allPlayersReady) {
            console.log('모든 플레이어가 discussionView 준비 완료, 토론 시작');
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
