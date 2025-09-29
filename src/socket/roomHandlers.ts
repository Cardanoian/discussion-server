import { Server, Socket } from 'socket.io';
import { BattleRoom, Subject } from '../types/database';
import { supabase } from '../supabaseClient';
import { startBattleLogic, battleStates } from './battleHandlers';
import { requestManager } from '../utils/RequestManager';
import { mockSubjects } from '../utils/mockSubjects';

export const rooms: BattleRoom[] = [];

const createRoom = (roomId: string, subject: Subject): BattleRoom => ({
  roomId,
  subject,
  players: [],
  isFull: false,
  battleStarted: false,
  hasReferee: false,
  isCompleted: false,
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
        callback({ subjects: mockSubjects });
        return;
      }

      // console.log('클라이언트에 주제를 전송합니다:', data);
      callback({ subjects: data });
    } catch (err) {
      console.error('데이터베이스 연결 실패, 대체 주제를 사용합니다:', err);

      // console.log('Sending fallback subjects to client:', fallbackSubjects);
      callback({ subjects: mockSubjects });
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

        // 역할 결정: 관리자면 심판, 아니면 플레이어
        const role = userData.is_admin ? 'referee' : 'player';
        if (role === 'referee') {
          newRoom.hasReferee = true;
        }

        // 동일 userId가 이미 있으면 socketId만 갱신, 없으면 push
        const existingPlayer = newRoom.players.find((p) => p.userId === userId);
        if (existingPlayer) {
          existingPlayer.socketId = socket.id;
        } else {
          newRoom.players.push({
            socketId: socket.id,
            userId,
            displayname: userData.display_name,
            isReady: false,
            role,
            rating: userData.rating,
            wins: userData.wins,
            loses: userData.loses,
          });
        }
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
      if (room && !room.battleStarted) {
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

          // 역할 결정: 플레이어 수에 따라 결정
          const playerCount = room.players.filter(
            (p) => p.role === 'player'
          ).length;
          const role = playerCount < 2 ? 'player' : 'spectator';

          // 동일 userId가 이미 있으면 socketId만 갱신, 없으면 push
          const existingPlayer = room.players.find((p) => p.userId === userId);
          if (existingPlayer) {
            existingPlayer.socketId = socket.id;
          } else {
            room.players.push({
              socketId: socket.id,
              userId,
              displayname: userData.display_name,
              isReady: false,
              role,
              rating: userData.rating,
              wins: userData.wins,
              loses: userData.loses,
            });
          }
          socket.join(roomId);

          // 플레이어 수가 2명 이상이면 토론 시작 가능
          callback({ room });
          io.to(roomId).emit('room_update', room);
          io.emit(
            'rooms_update',
            rooms.filter((r) => !r.battleStarted)
          );
        } catch (error) {
          console.error('방 참가 오류:', error);
          callback({ error: '방 참가 중 오류가 발생했습니다.' });
        } finally {
          requestManager.finishProcessing(socket.id, 'join_room');
        }
      } else {
        requestManager.finishProcessing(socket.id, 'join_room');
        callback({ error: '방을 찾을 수 없거나 이미 시작되었습니다.' });
      }
    }
  );

  socket.on('get_rooms', (callback) => {
    callback({ rooms: rooms.filter((r) => !r.battleStarted) });
  });

  // 내가 들어가 있는 방 반환
  socket.on('get_my_room', ({ userId }, callback) => {
    console.log('get_my_room 요청:', { userId, totalRooms: rooms.length });

    const myRoom = rooms.find((room) =>
      room.players.some((p) => p.userId === userId)
    );

    if (myRoom) {
      console.log('방 찾음:', {
        roomId: myRoom.roomId,
        battleStarted: myRoom.battleStarted,
        playersCount: myRoom.players.length,
        players: myRoom.players.map((p) => ({
          userId: p.userId,
          role: p.role,
          position: p.position,
        })),
      });
      callback({ room: myRoom });
    } else {
      console.log(
        '방을 찾을 수 없음. 현재 방 목록:',
        rooms.map((r) => ({
          roomId: r.roomId,
          players: r.players.map((p) => p.userId),
        }))
      );
      callback({ room: null });
    }
  });

  // 사용자 프로필 정보 반환
  socket.on('get_user_profile', async ({ userId }, callback) => {
    console.log('get_user_profile 요청:', userId);

    try {
      const { data: profile, error } = await supabase
        .from('user_profile')
        .select('*')
        .eq('user_uuid', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        console.error('사용자 프로필 조회 오류:', error);
        callback({ userProfile: null, error: error.message });
        return;
      }

      if (profile) {
        console.log('사용자 프로필 조회 성공:', profile);
        callback({ userProfile: profile, error: null });
      } else {
        // 프로필이 없으면 기본 프로필 생성
        console.log('프로필이 없어서 새로 생성:', userId);
        const { data: newProfile, error: createError } = await supabase
          .from('user_profile')
          .insert({
            user_uuid: userId,
            display_name: null,
            rating: 1500,
            wins: 0,
            loses: 0,
          })
          .select()
          .single();

        if (createError) {
          console.error('사용자 프로필 생성 오류:', createError);
          callback({ userProfile: null, error: createError.message });
        } else {
          console.log('새 사용자 프로필 생성 성공:', newProfile);
          callback({ userProfile: newProfile, error: null });
        }
      }
    } catch (error) {
      console.error('사용자 프로필 처리 중 오류:', error);
      callback({ userProfile: null, error: String(error) });
    }
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

            // 플레이어 역할인 사람이 2명 이상이고 모두 준비되었는지 확인
            // 관전자와 심판은 준비 완료 상태와 관계없이 토론 시작 가능
            const players = room.players.filter((p) => p.role === 'player');
            const readyPlayers = players.filter((p) => p.isReady);

            if (players.length >= 2 && readyPlayers.length >= 2) {
              // 최소 2명의 플레이어가 준비되면 토론 시작
              room.battleStarted = true;
              io.to(roomId).emit('battle_start', room);
              io.emit(
                'rooms_update',
                rooms.filter((r) => !r.battleStarted)
              );
            }
          }
        }
      } finally {
        requestManager.finishProcessing(socket.id, 'player_ready');
      }
    }
  );

  // 역할 선택 핸들러 추가
  socket.on(
    'select_role',
    async ({
      roomId,
      userId,
      role,
    }: {
      roomId: string;
      userId: string;
      role: 'player' | 'spectator' | 'referee';
    }) => {
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'select_role')) {
        return;
      }

      try {
        const room = rooms.find((r) => r.roomId === roomId);
        if (room) {
          const player = room.players.find((p) => p.userId === userId);
          if (player) {
            // 심판 역할 선택 시 관리자 권한 확인
            if (role === 'referee') {
              const { data: userData, error: userError } = await supabase
                .from('user_profile')
                .select('is_admin')
                .eq('user_uuid', userId)
                .single();

              if (userError || !userData || !userData.is_admin) {
                socket.emit('role_select_error', {
                  error: '심판 권한이 없습니다.',
                });
                return;
              }
            }

            // 기존 심판이 다른 역할로 변경하는 경우
            if (player.role === 'referee' && role !== 'referee') {
              room.hasReferee = room.players.some(
                (p) => p.userId !== userId && p.role === 'referee'
              );
            }
            // 새로 심판이 되는 경우
            else if (role === 'referee') {
              room.hasReferee = true;
            }

            player.role = role;
            // 역할이 변경되면 입장과 준비 상태 초기화
            player.position = undefined;
            player.isReady = false;

            io.to(roomId).emit('room_update', room);
            socket.emit('role_selected', { role });
          }
        }
      } catch (error) {
        console.error('역할 선택 오류:', error);
        socket.emit('role_select_error', {
          error: '역할 선택 중 오류가 발생했습니다.',
        });
      } finally {
        requestManager.finishProcessing(socket.id, 'select_role');
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
      position: 'agree' | 'disagree' | null;
    }) => {
      // 중복 요청 방지
      if (!requestManager.startProcessing(socket.id, 'select_position')) {
        return;
      }

      try {
        const room = rooms.find((r) => r.roomId === roomId);
        if (room) {
          const player = room.players.find((p) => p.userId === userId);
          if (player && player.role === 'player') {
            // 플레이어만 입장 선택 가능
            // 같은 입장을 다시 선택하면 취소
            if (player.position === position) {
              player.position = undefined;
              player.isReady = false;
            } else {
              player.position = position === null ? undefined : position;
            }

            io.to(roomId).emit('room_update', room);
            socket.emit('position_selected', { position: player.position });
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
            // console.log('모든 플레이어가 discussionView 준비 완료, 역할 할당 후 토론 시작');

            // 토론 시작 전에 플레이어 역할과 입장을 확정
            const playerRolePlayers = room.players.filter(
              (p) => p.role === 'player'
            );

            // 플레이어가 2명 이상이고 입장이 설정되지 않은 경우 자동 할당
            if (playerRolePlayers.length >= 2) {
              const playersWithoutPosition = playerRolePlayers.filter(
                (p) => !p.position
              );

              if (playersWithoutPosition.length > 0) {
                // 입장이 없는 플레이어들에게 자동으로 입장 할당
                const availablePositions: ('agree' | 'disagree')[] = [];

                const hasAgree = playerRolePlayers.some(
                  (p) => p.position === 'agree'
                );
                const hasDisagree = playerRolePlayers.some(
                  (p) => p.position === 'disagree'
                );

                if (!hasAgree) availablePositions.push('agree');
                if (!hasDisagree) availablePositions.push('disagree');

                // 입장이 없는 플레이어들에게 순서대로 할당
                playersWithoutPosition.forEach((player, index) => {
                  if (index < availablePositions.length) {
                    player.position = availablePositions[index];
                  }
                });
              }
            }

            // 플레이어 목록 업데이트 이벤트를 토론 시작 전에 전송
            io.to(roomId).emit('player_list_updated', {
              players: room.players.map((p) => ({
                userId: p.userId,
                role: p.role,
                position: p.position,
              })),
            });

            // 잠시 대기 후 토론 시작 (클라이언트가 역할 정보를 처리할 시간 제공)
            setTimeout(() => {
              startBattleLogic(io, room);
            }, 500);
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
          // 모든 참여자가 나간 경우 방과 battleStates 모두 정리
          rooms.splice(roomIndex, 1);
          if (battleStates[roomId]) {
            delete battleStates[roomId];
            console.log(
              `방 ${roomId} 완전 정리 완료 (방, battleStates 모두 삭제)`
            );
          }
        } else {
          room.players.forEach((p) => (p.isReady = false));
          // 심판이 나갔는지 확인
          room.hasReferee = room.players.some((p) => p.role === 'referee');
          io.to(roomId).emit('room_update', room);
        }
        io.emit(
          'rooms_update',
          rooms.filter((r) => !r.battleStarted)
        );
      }
    }
  );
};
