import { BattleState, MessageEntry } from '../types/battle';
import { Server, Socket } from 'socket.io';
import { GoogleGenAI } from '@google/genai';
import { BattleRoom } from '../types/database';
import {
  startTurnTimer,
  updatePlayerTime,
  checkTimeLimit,
  handleTimeOverflow,
  handleAutomaticDefeat,
} from '../utils/timeUtils';
import { calculateCombinedScore } from '../utils/calculateCombinedScore';
import { saveBattleResult } from '../utils/saveBattleResult';
import { updateUserStats } from '../utils/updateUserStats';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export const battleStates: BattleState = {};

// 메시지를 서버 상태에 추가하고 클라이언트에 브로드캐스트하는 헬퍼 함수
const addMessage = (
  io: Server,
  roomId: string,
  sender: 'system' | 'judge' | 'agree' | 'disagree',
  text: string
) => {
  const state = battleStates[roomId];
  if (!state) return;

  const message: MessageEntry = {
    sender,
    text,
    timestamp: Date.now(),
  };

  // 중복 메시지 방지
  const isDuplicate = state.messages.some(
    (msg) => msg.sender === sender && msg.text === text
  );

  if (!isDuplicate) {
    state.messages.push(message);
    // 전체 메시지 목록을 클라이언트에 전송
    io.to(roomId).emit('messages_updated', state.messages);
  }
};

// 토론 시작 로직을 별도 함수로 분리
export const startBattleLogic = async (io: Server, room: BattleRoom) => {
  const { roomId } = room;
  // console.log('토론 시작 로직 실행:', roomId, room);

  try {
    if (!room.subject) {
      console.error('주제 정보 없음:', room);
      io.to(roomId).emit(
        'battle_error',
        '주제 정보가 없어 대전을 시작할 수 없습니다.'
      );
      return;
    }

    // console.log('플레이어 정보:', room.players);

    // 찬성/반대 플레이어 구분
    const agreePlayer = room.players.find((p) => p.position === 'agree');
    const disagreePlayer = room.players.find((p) => p.position === 'disagree');

    // console.log('찬성측 플레이어:', agreePlayer);
    // console.log('반대측 플레이어:', disagreePlayer);

    if (!agreePlayer || !disagreePlayer) {
      console.error('플레이어 입장 설정 안됨');
      // 입장이 설정되지 않은 경우, 자동으로 설정
      if (room.players.length === 2) {
        room.players[0].position = 'agree';
        room.players[1].position = 'disagree';
        // console.log('자동으로 입장 설정:', room.players);
      } else {
        io.to(roomId).emit(
          'battle_error',
          '플레이어의 입장이 설정되지 않았습니다.'
        );
        return;
      }
    }

    const finalAgreePlayer = room.players.find((p) => p.position === 'agree')!;
    const finalDisagreePlayer = room.players.find(
      (p) => p.position === 'disagree'
    )!;

    // 배틀 상태 초기화
    battleStates[roomId] = {
      stage: 0,
      discussionLog: [],
      messages: [], // 모든 메시지 저장
      players: room.players,
      subject: room.subject,
      agreePlayer: finalAgreePlayer,
      disagreePlayer: finalDisagreePlayer,
      timers: {
        [finalAgreePlayer.userId]: {
          totalTimeUsed: 0,
          roundTimeUsed: 0,
          penaltyPoints: 0,
          penaltyCount: 0,
          isOvertime: false,
        },
        [finalDisagreePlayer.userId]: {
          totalTimeUsed: 0,
          roundTimeUsed: 0,
          penaltyPoints: 0,
          penaltyCount: 0,
          isOvertime: false,
        },
      },
      roundTimeLimit: 120000, // 2분
      totalTimeLimit: 300000, // 5분
      overtimeLimit: 30000, // 30초
      penaltyPoints: 3, // 감점 점수
      maxPenaltyPoints: 18, // 자동 패배 기준
      isGameEndedByPenalty: false,
    };

    // console.log('배틀 상태 초기화 완료:', battleStates[roomId]);

    // AI 심판 시작 - 주제 및 절차 안내
    const openingMessage = `안녕하세요! AI 심판입니다. 

오늘의 토론 주제는 "${room.subject.title}"입니다.

${room.subject.text}

토론은 다음과 같은 순서로 진행됩니다:
1. 찬성측 대표발언
2. 반대측 대표발언  
3. 반대측 질문
4. 찬성측 답변 및 질문
5. 반대측 답변 및 질문
6. 찬성측 답변 및 질문
7. 반대측 답변
8. 찬성측 최종발언
9. 반대측 최종발언
10. AI 심판 평가

그럼 먼저 찬성측인 ${finalAgreePlayer.displayname}님부터 대표발언을 시작해주세요.`;

    // 서버에서 메시지 관리 - AI 심판 메시지 추가
    addMessage(io, roomId, 'judge', openingMessage);

    // 1단계로 진행 - 찬성측 대표발언
    battleStates[roomId].stage = 1;
    startTurnTimer(io, roomId, finalAgreePlayer.userId);

    const turnMessage = `찬성측 ${finalAgreePlayer.displayname}님의 대표발언 차례입니다.`;
    addMessage(io, roomId, 'system', turnMessage);

    // console.log('1단계 진행 - 찬성측 대표발언');
    io.to(roomId).emit('turn_info', {
      currentPlayerId: finalAgreePlayer.userId,
      stage: 1,
      message: turnMessage,
      stageDescription: '찬성측 대표발언',
    });
  } catch (error) {
    console.error('토론 시작 오류:', error);
    io.to(roomId).emit('battle_error', '대전 시작 중 오류가 발생했습니다.');
  }
};

export const registerBattleHandlers = (io: Server, socket: Socket) => {
  // console.log(`battleHandlers 등록됨 for 소켓: ${socket.id}`);

  socket.on('start_battle_logic', async (room: BattleRoom) => {
    const { roomId } = room;
    // console.log('토론 시작 로직 실행:', roomId, room);

    try {
      if (!room.subject) {
        console.error('주제 정보 없음:', room);
        io.to(roomId).emit(
          'battle_error',
          '주제 정보가 없어 대전을 시작할 수 없습니다.'
        );
        return;
      }

      // console.log('플레이어 정보:', room.players);

      // 찬성/반대 플레이어 구분
      const agreePlayer = room.players.find((p) => p.position === 'agree');
      const disagreePlayer = room.players.find(
        (p) => p.position === 'disagree'
      );

      // console.log('찬성측 플레이어:', agreePlayer);
      // console.log('반대측 플레이어:', disagreePlayer);

      if (!agreePlayer || !disagreePlayer) {
        console.error('플레이어 입장 설정 안됨');
        // 입장이 설정되지 않은 경우, 자동으로 설정
        if (room.players.length === 2) {
          room.players[0].position = 'agree';
          room.players[1].position = 'disagree';
          // console.log('자동으로 입장 설정:', room.players);
        } else {
          io.to(roomId).emit(
            'battle_error',
            '플레이어의 입장이 설정되지 않았습니다.'
          );
          return;
        }
      }

      const finalAgreePlayer = room.players.find(
        (p) => p.position === 'agree'
      )!;
      const finalDisagreePlayer = room.players.find(
        (p) => p.position === 'disagree'
      )!;

      // 배틀 상태 초기화
      battleStates[roomId] = {
        stage: 0,
        discussionLog: [],
        messages: [], // 모든 메시지 저장
        players: room.players,
        subject: room.subject,
        agreePlayer: finalAgreePlayer,
        disagreePlayer: finalDisagreePlayer,
        timers: {
          [finalAgreePlayer.userId]: {
            totalTimeUsed: 0,
            roundTimeUsed: 0,
            penaltyPoints: 0,
            penaltyCount: 0,
            isOvertime: false,
          },
          [finalDisagreePlayer.userId]: {
            totalTimeUsed: 0,
            roundTimeUsed: 0,
            penaltyPoints: 0,
            penaltyCount: 0,
            isOvertime: false,
          },
        },
        roundTimeLimit: 120000, // 2분
        totalTimeLimit: 300000, // 5분
        overtimeLimit: 30000, // 30초
        penaltyPoints: 3, // 감점 점수
        maxPenaltyPoints: 18, // 자동 패배 기준
        isGameEndedByPenalty: false,
      };

      // console.log('배틀 상태 초기화 완료:', battleStates[roomId]);

      // AI 심판 시작 - 주제 및 절차 안내
      const openingMessage = `안녕하세요! AI 심판입니다. 

오늘의 토론 주제는 "${room.subject.title}"입니다.

${room.subject.text}

토론은 다음과 같은 순서로 진행됩니다:
1. 찬성측 대표발언
2. 반대측 대표발언  
3. 반대측 질문
4. 찬성측 답변 및 질문
5. 반대측 답변 및 질문
6. 찬성측 답변 및 질문
7. 반대측 답변
8. 찬성측 최종발언
9. 반대측 최종발언
10. AI 심판 평가

그럼 먼저 찬성측인 ${finalAgreePlayer.displayname}님부터 대표발언을 시작해주세요.`;

      // console.log('AI 심판 메시지 전송:', openingMessage);
      io.to(roomId).emit('ai_judge_message', {
        message: openingMessage,
        stage: 0,
      });

      // 플레이어 목록 업데이트 이벤트 전송 (클라이언트 역할 할당용)
      io.to(roomId).emit('player_list_updated', {
        players: room.players.map((p) => ({
          userId: p.userId,
          role: p.role,
          position: p.position,
          displayName: p.displayname, // displayname 추가
        })),
      });

      // 1단계로 진행 - 찬성측 대표발언
      battleStates[roomId].stage = 1;
      startTurnTimer(io, roomId, finalAgreePlayer.userId);

      const turnMessage = `찬성측 ${finalAgreePlayer.displayname}님의 대표발언 차례입니다.`;
      addMessage(io, roomId, 'system', turnMessage);

      // console.log('1단계 진행 - 찬성측 대표발언');
      io.to(roomId).emit('turn_info', {
        currentPlayerId: finalAgreePlayer.userId,
        stage: 1,
        message: turnMessage,
        stageDescription: '찬성측 대표발언',
      });
    } catch (error) {
      console.error('토론 시작 오류:', error);
      io.to(roomId).emit('battle_error', '대전 시작 중 오류가 발생했습니다.');
    }
  });

  socket.on(
    'send_message',
    async ({
      roomId,
      userId,
      message,
    }: {
      roomId: string;
      userId: string;
      message: string;
    }) => {
      // console.log('send_message 이벤트 수신:', { roomId, userId, message });

      const room = io.sockets.adapter.rooms.get(roomId);
      if (!room) {
        console.log('룸을 찾을 수 없음:', roomId);
        return;
      }

      const state = battleStates[roomId];
      if (!state) {
        console.log('배틀 상태를 찾을 수 없음:', roomId);
        return;
      }

      const playerInfo = state.players.find((p) => p.userId === userId);
      if (!playerInfo) return;

      // 게임이 감점으로 종료된 경우 메시지 처리 중단
      if (state.isGameEndedByPenalty) return;

      // 시간 체크 및 업데이트
      updatePlayerTime(roomId, userId);
      checkTimeLimit(io, roomId, userId);

      // 시간 초과로 게임이 종료된 경우 메시지 처리 중단
      if (state.isGameEndedByPenalty) return;

      // 메시지 로그에 추가
      state.discussionLog.push({ userId, message, stage: state.stage });

      // 서버에서 메시지 관리 - 플레이어 메시지 추가
      const sender = userId === state.agreePlayer.userId ? 'agree' : 'disagree';
      addMessage(io, roomId, sender, message);

      // 다음 단계로 진행
      await proceedToNextStage(io, roomId, state);
    }
  );

  // 클라이언트에서 시간 초과 신호를 받는 핸들러
  socket.on(
    'time_overflow',
    ({
      roomId,
      userId,
      type,
    }: {
      roomId: string;
      userId: string;
      type: 'round' | 'total' | 'overtime';
    }) => {
      // console.log('time_overflow 이벤트 수신:', { roomId, userId, type });

      const state = battleStates[roomId];
      if (!state) {
        console.log('배틀 상태를 찾을 수 없음:', roomId);
        return;
      }

      // 서버에서 시간 초과 처리
      handleTimeOverflow(
        io,
        roomId,
        userId,
        type === 'overtime' ? 'round' : type
      );
    }
  );

  // 심판 조작 기능들
  socket.on(
    'referee_add_points',
    ({
      roomId,
      targetUserId,
      points,
      refereeId,
    }: {
      roomId: string;
      targetUserId: string;
      points: number;
      refereeId: string;
    }) => {
      const state = battleStates[roomId];
      if (!state) return;

      // 심판 권한 확인
      const referee = state.players.find(
        (p) => p.userId === refereeId && p.role === 'referee'
      );
      if (!referee) return;

      const targetPlayer = state.players.find((p) => p.userId === targetUserId);
      if (!targetPlayer) return;

      // 가산점 적용 (감점 점수 감소)
      const playerTimer = state.timers[targetUserId];
      if (playerTimer) {
        playerTimer.penaltyPoints = Math.max(
          0,
          playerTimer.penaltyPoints - points
        );

        io.to(roomId).emit('penalty_applied', {
          userId: targetUserId,
          penaltyPoints: playerTimer.penaltyPoints,
          maxPenaltyPoints: state.maxPenaltyPoints,
          message: `인간심판이 ${
            targetPlayer.position == 'agree' ? '찬성' : '반대'
          }측 플레이어 ${
            targetPlayer.displayname
          }님에게 ${points}점의 가산점을 부여했습니다. (${
            playerTimer.penaltyPoints
          }/${state.maxPenaltyPoints}점)`,
        });
      }
    }
  );

  // 인간 심판 채점 제출
  socket.on(
    'referee_submit_scores',
    async ({
      roomId,
      scores,
      refereeId,
    }: {
      roomId: string;
      scores: { agree: number; disagree: number };
      refereeId: string;
    }) => {
      const state = battleStates[roomId];
      if (!state) return;

      // 심판 권한 확인
      const referee = state.players.find(
        (p) => p.userId === refereeId && p.role === 'referee'
      );
      if (!referee) return;

      // 인간 심판 점수 저장
      state.humanRefereeScores = scores;

      // AI 채점 결과와 통합하여 최종 결과 계산
      if (state.aiEvaluationResult) {
        const finalResult = calculateCombinedScore(
          state.aiEvaluationResult,
          scores
        );

        // 최종 결과 전송
        io.to(roomId).emit('battle_result', finalResult);

        const winnerId = finalResult.winner;
        const loserId = state.players.find(
          (p) => p.userId !== winnerId
        )?.userId;

        // 사용자 통계 업데이트
        if (winnerId && loserId) {
          await updateUserStats(winnerId, loserId, true);
          await updateUserStats(loserId, winnerId, false);
        }

        // battles 테이블에 결과 저장
        await saveBattleResult(
          state.agreePlayer.userId,
          state.disagreePlayer.userId,
          winnerId,
          state.subject.uuid,
          state.discussionLog,
          finalResult
        );

        // 상태 정리
        delete battleStates[roomId];
      }
    }
  );

  socket.on(
    'referee_deduct_points',
    ({
      roomId,
      targetUserId,
      points,
      refereeId,
    }: {
      roomId: string;
      targetUserId: string;
      points: number;
      refereeId: string;
    }) => {
      const state = battleStates[roomId];
      if (!state) return;

      // 심판 권한 확인
      const referee = state.players.find(
        (p) => p.userId === refereeId && p.role === 'referee'
      );
      if (!referee) return;

      const targetPlayer = state.players.find((p) => p.userId === targetUserId);
      if (!targetPlayer) return;

      // 감점 적용
      const playerTimer = state.timers[targetUserId];
      if (playerTimer) {
        playerTimer.penaltyPoints = Math.min(
          state.maxPenaltyPoints,
          playerTimer.penaltyPoints + points
        );

        // 18점 이상 시 자동 패배
        if (playerTimer.penaltyPoints >= state.maxPenaltyPoints) {
          handleAutomaticDefeat(io, roomId, targetUserId);
          return;
        }

        io.to(roomId).emit('penalty_applied', {
          userId: targetUserId,
          penaltyPoints: playerTimer.penaltyPoints,
          maxPenaltyPoints: state.maxPenaltyPoints,
          message: `심판이 ${
            targetPlayer.position === 'agree' ? '찬성' : '반대'
          }측 플레이어 ${
            targetPlayer.displayname
          }님에게 ${points}점의 감점을 부여했습니다. (${
            playerTimer.penaltyPoints
          }/${state.maxPenaltyPoints}점)`,
        });
      }
    }
  );

  socket.on(
    'referee_extend_time',
    ({
      roomId,
      targetUserId,
      seconds,
      refereeId,
    }: {
      roomId: string;
      targetUserId: string;
      seconds: number;
      refereeId: string;
    }) => {
      const state = battleStates[roomId];
      if (!state) return;

      // 심판 권한 확인
      const referee = state.players.find(
        (p) => p.userId === refereeId && p.role === 'referee'
      );
      if (!referee) return;

      const targetPlayer = state.players.find((p) => p.userId === targetUserId);
      if (!targetPlayer) return;

      // 시간 연장 (전체 시간 증가)
      const playerTimer = state.timers[targetUserId];
      if (playerTimer) {
        playerTimer.totalTimeUsed = Math.max(
          0,
          playerTimer.totalTimeUsed - seconds * 1000
        );

        io.to(roomId).emit('time_extended', {
          userId: targetUserId,
          seconds,
          message: `심판이 ${
            targetPlayer.position === 'agree' ? '찬성' : '반대'
          }측 플레이어 ${
            targetPlayer.displayname
          }님에게 ${seconds}초 시간을 연장해주었습니다.`,
        });
      }
    }
  );

  socket.on(
    'referee_reduce_time',
    ({
      roomId,
      targetUserId,
      seconds,
      refereeId,
    }: {
      roomId: string;
      targetUserId: string;
      seconds: number;
      refereeId: string;
    }) => {
      const state = battleStates[roomId];
      if (!state) return;

      // 심판 권한 확인
      const referee = state.players.find(
        (p) => p.userId === refereeId && p.role === 'referee'
      );
      if (!referee) return;

      const targetPlayer = state.players.find((p) => p.userId === targetUserId);
      if (!targetPlayer) return;

      // 시간 단축 (전체 시간 감소)
      const playerTimer = state.timers[targetUserId];
      if (playerTimer) {
        playerTimer.totalTimeUsed += seconds * 1000;

        io.to(roomId).emit('time_reduced', {
          userId: targetUserId,
          seconds,
          message: `심판이 ${
            targetPlayer.position === 'agree' ? '찬성' : '반대'
          }측 플레이어 ${
            targetPlayer.displayname
          }님의 시간을 ${seconds}초 단축했습니다.`,
        });
      }
    }
  );

  // 클라이언트가 메시지 목록을 요청하는 핸들러
  socket.on('get_messages', ({ roomId }: { roomId: string }) => {
    const state = battleStates[roomId];
    if (state) {
      socket.emit('messages_updated', state.messages);
    }
  });

  // 클라이언트가 전체 방 상태를 요청하는 핸들러 (새로고침 시 상태 동기화용)
  socket.on(
    'get_room_state',
    ({ roomId, userId }: { roomId: string; userId: string }) => {
      const state = battleStates[roomId];
      if (!state) {
        // 토론이 시작되지 않았거나 이미 종료된 경우
        socket.emit('room_state_updated', {
          messages: [],
          stage: 0,
          currentTurn: '',
          isMyTurn: false,
          battleEnded: true,
          timerState: {
            roundTimeRemaining: 120,
            totalTimeRemaining: 300,
            isRunning: false,
            isOvertime: false,
            overtimeRemaining: 30,
            roundTimeLimit: 120,
            totalTimeLimit: 300,
          },
          players: [],
        });
        return;
      }

      // 현재 턴인 플레이어 찾기
      let currentTurnUserId = '';
      let currentTurnPlayer = null;

      if (state.stage >= 1 && state.stage <= 9) {
        // 각 단계별 턴 결정
        switch (state.stage) {
          case 1: // 찬성측 대표발언
          case 4: // 찬성측 답변 및 질문
          case 6: // 찬성측 답변 및 질문
          case 8: // 찬성측 최종발언
            currentTurnUserId = state.agreePlayer.userId;
            currentTurnPlayer = state.agreePlayer;
            break;
          case 2: // 반대측 대표발언
          case 3: // 반대측 질문
          case 5: // 반대측 답변 및 질문
          case 7: // 반대측 답변
          case 9: // 반대측 최종발언
            currentTurnUserId = state.disagreePlayer.userId;
            currentTurnPlayer = state.disagreePlayer;
            break;
        }
      }

      // 타이머 상태 계산
      const playerTimer = currentTurnUserId
        ? state.timers[currentTurnUserId]
        : null;
      const currentTime = Date.now();
      const turnStartTime = state.currentTurnStartTime || currentTime;

      let roundTimeRemaining = Math.max(
        0,
        Math.floor(
          (state.roundTimeLimit - (currentTime - turnStartTime)) / 1000
        )
      );
      let totalTimeRemaining = playerTimer
        ? Math.max(
            0,
            Math.floor(
              (state.totalTimeLimit - playerTimer.totalTimeUsed) / 1000
            )
          )
        : 300;

      // 연장시간 계산
      let isOvertime = false;
      let overtimeRemaining = 30;
      if (
        roundTimeRemaining <= 0 &&
        playerTimer &&
        !playerTimer.isOvertime &&
        currentTurnUserId
      ) {
        isOvertime = true;
        overtimeRemaining = Math.max(
          0,
          Math.floor(
            (state.overtimeLimit -
              (currentTime - turnStartTime - state.roundTimeLimit)) /
              1000
          )
        );
      }

      const timerState = {
        roundTimeRemaining,
        totalTimeRemaining,
        isRunning:
          currentTurnUserId === userId && state.stage >= 1 && state.stage <= 9,
        isOvertime,
        overtimeRemaining,
        roundTimeLimit: Math.floor(state.roundTimeLimit / 1000),
        totalTimeLimit: Math.floor(state.totalTimeLimit / 1000),
      };

      // 단계별 설명
      const getStageDescription = (stage: number): string => {
        switch (stage) {
          case 1:
            return '찬성측 대표발언';
          case 2:
            return '반대측 대표발언';
          case 3:
            return '반대측 질문';
          case 4:
            return '찬성측 답변 및 질문';
          case 5:
            return '반대측 답변 및 질문';
          case 6:
            return '찬성측 답변 및 질문';
          case 7:
            return '반대측 답변';
          case 8:
            return '찬성측 최종발언';
          case 9:
            return '반대측 최종발언';
          case 10:
            return 'AI 심판 평가';
          default:
            return '토론 시작 전';
        }
      };

      // 전체 상태 정보 전송
      socket.emit('room_state_updated', {
        messages: state.messages,
        stage: state.stage,
        currentTurn: currentTurnUserId,
        isMyTurn: currentTurnUserId === userId,
        battleEnded: state.stage >= 10 || state.isGameEndedByPenalty,
        timerState,
        stageDescription: getStageDescription(state.stage),
        players: state.players.map((p) => ({
          userId: p.userId,
          role: p.role,
          position: p.position,
          displayName: p.displayname,
        })),
        timerInfo: {
          myPenaltyPoints: state.timers[userId]?.penaltyPoints || 0,
          opponentPenaltyPoints:
            Object.entries(state.timers).find(([id]) => id !== userId)?.[1]
              ?.penaltyPoints || 0,
          maxPenaltyPoints: state.maxPenaltyPoints,
        },
      });
    }
  );
};

// 다음 단계로 진행하는 함수
const proceedToNextStage = async (
  io: Server,
  roomId: string,
  state: BattleState[string]
) => {
  state.stage++;

  switch (state.stage) {
    case 2: // 반대측 대표발언
      startTurnTimer(io, roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 2,
        message: `반대측 ${state.disagreePlayer.displayname}님의 대표발언 차례입니다.`,
        stageDescription: '반대측 대표발언',
      });
      break;

    case 3: // 반대측 질문
      startTurnTimer(io, roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('ai_judge_message', {
        message: `이제 질문 단계입니다. 반대측 ${state.disagreePlayer.displayname}님이 찬성측에게 질문해주세요.`,
        stage: 3,
      });
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 3,
        message: `반대측 ${state.disagreePlayer.displayname}님의 질문 차례입니다.`,
        stageDescription: '반대측 질문',
      });
      break;

    case 4: // 찬성측 답변 및 질문
      startTurnTimer(io, roomId, state.agreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 4,
        message: `찬성측 ${state.agreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '찬성측 답변 및 질문',
      });
      break;

    case 5: // 반대측 답변 및 질문
      startTurnTimer(io, roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 5,
        message: `반대측 ${state.disagreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '반대측 답변 및 질문',
      });
      break;

    case 6: // 찬성측 답변 및 질문
      startTurnTimer(io, roomId, state.agreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 6,
        message: `찬성측 ${state.agreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '찬성측 답변 및 질문',
      });
      break;

    case 7: // 반대측 답변
      startTurnTimer(io, roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 7,
        message: `반대측 ${state.disagreePlayer.displayname}님의 답변 차례입니다.`,
        stageDescription: '반대측 답변',
      });
      break;

    case 8: // 찬성측 최종발언
      startTurnTimer(io, roomId, state.agreePlayer.userId);
      io.to(roomId).emit('ai_judge_message', {
        message: `이제 최종발언 단계입니다. 찬성측 ${state.agreePlayer.displayname}님부터 최종발언을 해주세요.`,
        stage: 8,
      });
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 8,
        message: `찬성측 ${state.agreePlayer.displayname}님의 최종발언 차례입니다.`,
        stageDescription: '찬성측 최종발언',
      });
      break;

    case 9: // 반대측 최종발언
      startTurnTimer(io, roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 9,
        message: `반대측 ${state.disagreePlayer.displayname}님의 최종발언 차례입니다.`,
        stageDescription: '반대측 최종발언',
      });
      break;

    case 10: // AI 심판 평가
      await conductAIEvaluation(io, roomId, state);
      break;

    default:
      break;
  }
};

// AI 평가 수행 함수
const conductAIEvaluation = async (
  io: Server,
  roomId: string,
  state: BattleState[string]
) => {
  io.to(roomId).emit('ai_judge_message', {
    message: '토론이 종료되었습니다. AI가 채점을 시작합니다...',
    stage: 10,
  });

  try {
    // 찬성측과 반대측 발언 분리
    const agreeMessages = state.discussionLog
      .filter((log) => log.userId === state.agreePlayer.userId)
      .map((log) => log.message)
      .join('\n');

    const disagreeMessages = state.discussionLog
      .filter((log) => log.userId === state.disagreePlayer.userId)
      .map((log) => log.message)
      .join('\n');

    const prompt = `
다음은 토론 내용입니다.
주제: ${state.subject.title}

찬성측 (${state.agreePlayer.displayname}) 발언:
${agreeMessages}

반대측 (${state.disagreePlayer.displayname}) 발언:
${disagreeMessages}

각 측의 주장에 대해 논리성, 근거의 타당성, 설득력을 기준으로 0점에서 100점 사이로 채점하고, 
각각에 대한 구체적인 잘한 점과 개선점을 제공해주세요.
최종적으로 누가 더 설득력 있었는지 결론을 내리고, 승자를 정해주세요.

출력 형식은 다음과 같은 JSON 객체로 만들어주세요:
{
  "agree": {
    "score": 점수(0-100),
    "good": "잘한 점에 대한 간단한 설명",
    "bad": "개선점에 대한 간단한 설명"
  },
  "disagree": {
    "score": 점수(0-100),
    "good": "잘한 점에 대한 간단한 설명", 
    "bad": "개선점에 대한 간단한 설명"
  },
  "winner": "agree" 또는 "disagree"
}
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const text = response.text ?? '';
    const resultJson = JSON.parse(text.replace(/```json|```/g, '').trim());

    // winner 필드가 position("agree"/"disagree")으로 반환된 경우 userId로 변환
    if (
      resultJson.winner === 'agree' ||
      resultJson.winner === state.agreePlayer.userId
    ) {
      resultJson.winner = state.agreePlayer.userId;
    } else if (
      resultJson.winner === 'disagree' ||
      resultJson.winner === state.disagreePlayer.userId
    ) {
      resultJson.winner = state.disagreePlayer.userId;
    }

    // JSON 결과를 자연스러운 줄글로 변환
    const textPrompt = `
다음 토론 채점 결과를 자연스러운 한국어 줄글로 변환해주세요:

찬성측 점수: ${resultJson.agree.score}점
찬성측 잘한 점: ${resultJson.agree.good}
찬성측 개선점: ${resultJson.agree.bad}

반대측 점수: ${resultJson.disagree.score}점
반대측 잘한 점: ${resultJson.disagree.good}
반대측 개선점: ${resultJson.disagree.bad}

승자: ${resultJson.winner === state.agreePlayer.userId ? '찬성측' : '반대측'}

위 정보를 바탕으로 토론 결과를 자연스럽게 설명하는 문장으로 작성해주세요. 
각 측의 점수와 피드백을 포함하되, 딱딱한 형식이 아닌 자연스러운 문체로 작성해주세요.

예시: "이번 토론에서 찬성측은 85점, 반대측은 78점을 받았습니다. 

찬성측은 체계적인 논리 구조와 구체적인 통계 자료를 바탕으로 한 근거 제시가 매우 뛰어났습니다. 
다만 감정적 호소나 청중과의 공감대 형성 부분에서는 다소 아쉬움이 있었고, 일부 주장에서 반대 의견에 대한 충분한 고려가 부족했습니다.

반대측은 실제 사례와 생생한 경험담을 효과적으로 활용하여 설득력 있는 주장을 펼쳤습니다. 
하지만 논리적 연결성이 다소 부족했고, 일부 주장에서 근거가 약하거나 감정에만 의존하는 경향이 있었습니다.

종합적으로 판단했을 때, 논리적 일관성과 근거의 타당성 면에서 우위를 보인 찬성측이 85대 78로 승리했습니다."

위와 같이 각 측의 점수, 구체적인 잘한 점과 개선점을 자세히 설명하고, 최종 승부 결과와 그 이유를 명확히 제시하는 형식으로 작성해주세요.
    `;

    const textResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: textPrompt,
      config: {
        thinkingConfig: {
          thinkingBudget: 0,
        },
      },
    });

    const resultText = textResponse.text?.trim() || '';

    // 심판 메시지로 줄글 결과 전송
    io.to(roomId).emit('ai_judge_message', {
      message: resultText,
      stage: 10,
    });

    // AI 채점 결과 저장
    state.aiEvaluationResult = resultJson;

    // 인간 심판이 있는지 확인
    const hasHumanReferee = state.players.some((p) => p.role === 'referee');

    if (hasHumanReferee) {
      // 인간 심판이 있으면 채점 모달 표시 요청
      const referee = state.players.find((p) => p.role === 'referee');
      if (referee) {
        io.to(referee.socketId).emit('show_referee_score_modal', {
          agreePlayerName: state.agreePlayer.displayname,
          disagreePlayerName: state.disagreePlayer.displayname,
          aiResult: resultJson,
        });
      }
    } else {
      // 인간 심판이 없으면 AI 결과만으로 종료
      io.to(roomId).emit('battle_result', resultJson);

      const winnerId = resultJson.winner;
      const loserId = state.players.find((p) => p.userId !== winnerId)?.userId;

      // 사용자 통계 업데이트
      if (winnerId && loserId) {
        await updateUserStats(winnerId, loserId, true);
        await updateUserStats(loserId, winnerId, false);
      }

      // battles 테이블에 결과 저장
      await saveBattleResult(
        state.agreePlayer.userId,
        state.disagreePlayer.userId,
        winnerId,
        state.subject.uuid,
        state.discussionLog,
        resultJson
      );

      // 상태 정리
      delete battleStates[roomId];
    }
  } catch (error) {
    console.error('AI 평가 오류:', error);
    io.to(roomId).emit('battle_error', 'AI 채점 중 오류가 발생했습니다.');
  }
};
