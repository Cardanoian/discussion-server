import { Server, Socket } from 'socket.io';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../supabaseClient';
import { BattleRoom } from '../types/database';
import {
  AIEvaluationResult,
  BattleState,
  DiscussionLogEntry,
} from '../types/battle';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const battleStates: BattleState = {};

// 타이머 관리 함수들
const startTurnTimer = (roomId: string, userId: string) => {
  const state = battleStates[roomId];
  if (!state) return;

  state.currentTurnStartTime = Date.now();
  state.timers[userId].roundTimeUsed = 0;
  state.timers[userId].isOvertime = false;

  // console.log(
  //   `턴 타이머 시작: ${userId}, 시작 시간: ${state.currentTurnStartTime}`
  // );
};

const calculateTimeUsed = (
  roomId: string,
  userId: string
): { roundTime: number; totalTime: number } => {
  const state = battleStates[roomId];
  if (!state || !state.currentTurnStartTime)
    return { roundTime: 0, totalTime: 0 };

  const currentTime = Date.now();
  const roundTimeUsed = currentTime - state.currentTurnStartTime;
  const totalTimeUsed = state.timers[userId].totalTimeUsed + roundTimeUsed;

  return { roundTime: roundTimeUsed, totalTime: totalTimeUsed };
};

const checkTimeLimit = (
  io: Server,
  roomId: string,
  userId: string
): boolean => {
  const state = battleStates[roomId];
  if (!state) return false;

  const { roundTime, totalTime } = calculateTimeUsed(roomId, userId);
  const playerTimer = state.timers[userId];

  // 라운드 시간 초과 체크
  if (roundTime > state.roundTimeLimit && !playerTimer.isOvertime) {
    handleTimeOverflow(io, roomId, userId, 'round');
    return true;
  }

  // 전체 시간 초과 체크
  if (totalTime > state.totalTimeLimit && !playerTimer.isOvertime) {
    handleTimeOverflow(io, roomId, userId, 'total');
    return true;
  }

  return false;
};

const handleTimeOverflow = (
  io: Server,
  roomId: string,
  userId: string,
  type: 'round' | 'total'
) => {
  const state = battleStates[roomId];
  if (!state) return;

  const playerTimer = state.timers[userId];
  const playerName =
    state.players.find((p) => p.userId === userId)?.displayname || '플레이어';

  // 3점 감점
  playerTimer.penaltyPoints += state.penaltyPoints;
  playerTimer.penaltyCount += 1;
  playerTimer.isOvertime = true;
  playerTimer.overtimeStarted = Date.now();

  // console.log(
  //   `시간 초과 처리: ${userId}, 감점: ${playerTimer.penaltyPoints}/${state.maxPenaltyPoints}`
  // );

  // 18점 이상 시 자동 패배
  if (playerTimer.penaltyPoints >= state.maxPenaltyPoints) {
    handleAutomaticDefeat(io, roomId, userId);
    return;
  }

  // 감점 알림
  const timeType = type === 'round' ? '라운드' : '전체';
  io.to(roomId).emit('penalty_applied', {
    userId,
    penaltyPoints: playerTimer.penaltyPoints,
    maxPenaltyPoints: state.maxPenaltyPoints,
    message: `${playerName}님이 ${timeType} 시간을 초과하여 3점 감점되었습니다. (${playerTimer.penaltyPoints}/${state.maxPenaltyPoints}점)`,
  });

  // 30초 연장시간 부여
  io.to(roomId).emit('overtime_granted', {
    userId,
    overtimeLimit: state.overtimeLimit,
    message: `${playerName}님에게 30초의 연장시간이 부여되었습니다.`,
  });
};

const handleAutomaticDefeat = (
  io: Server,
  roomId: string,
  defeatedUserId: string
) => {
  const state = battleStates[roomId];
  if (!state) return;

  const defeatedPlayer = state.players.find((p) => p.userId === defeatedUserId);
  const winnerId = state.players.find(
    (p) => p.userId !== defeatedUserId
  )?.userId;

  if (!winnerId || !defeatedPlayer) return;

  // 게임 즉시 종료
  state.isGameEndedByPenalty = true;

  // console.log(`자동 패배 처리: ${defeatedUserId} 패배, ${winnerId} 승리`);

  // 패배 메시지 전송
  io.to(roomId).emit('ai_judge_message', {
    message: `시간 초과로 인한 감점이 18점에 도달했습니다. ${defeatedPlayer.displayname}님의 패배로 경기가 종료됩니다.`,
    stage: 11, // 특별 종료 단계
  });

  // 자동 승부 결과 처리 (AI 심판 없이)
  const automaticResult: AIEvaluationResult = {
    agree: {
      score: winnerId === state.agreePlayer.userId ? 100 : 0,
      good: '시간 관리 우수',
      bad: '',
    },
    disagree: {
      score: winnerId === state.disagreePlayer.userId ? 100 : 0,
      good: '시간 관리 우수',
      bad: '',
    },
    winner: winnerId,
  };

  // 결과 전송 및 통계 업데이트
  io.to(roomId).emit('battle_result', automaticResult);

  // 비동기 처리
  (async () => {
    await updateUserStats(winnerId, defeatedUserId, true);
    await updateUserStats(defeatedUserId, winnerId, false);

    // battles 테이블에 결과 저장
    await saveBattleResult(
      state.agreePlayer.userId,
      state.disagreePlayer.userId,
      winnerId,
      state.subject.uuid,
      state.discussionLog,
      automaticResult
    );
  })();

  // 상태 정리
  delete battleStates[roomId];
};

const updatePlayerTime = (roomId: string, userId: string) => {
  const state = battleStates[roomId];
  if (!state || !state.currentTurnStartTime) return;

  const { roundTime, totalTime } = calculateTimeUsed(roomId, userId);
  const playerTimer = state.timers[userId];

  playerTimer.roundTimeUsed = roundTime;
  playerTimer.totalTimeUsed = totalTime;

  // console.log(
  //   `시간 업데이트: ${userId}, 라운드: ${roundTime}ms, 전체: ${totalTime}ms`
  // );
};

// ELO 레이팅 계산 함수
const calculateEloRating = (
  playerRating: number,
  opponentRating: number,
  won: boolean
): number => {
  // K값 결정 (레이팅에 따라 차등 적용)
  const kFactor: number =
    35.0115796 / (1 + Math.exp((playerRating - 1930.63327881) / 240.64853294)) +
    9.99989887;

  // 예상 승률 계산
  const expectedScore =
    1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));

  // 실제 결과 (승리: 1, 패배: 0)
  const actualScore = won ? 1 : 0;

  // 새로운 레이팅 계산
  const newRating = playerRating + kFactor * (actualScore - expectedScore);

  return newRating;
};

// 사용자 통계 업데이트 함수
const updateUserStats = async (
  userId: string,
  opponentId: string,
  won: boolean
) => {
  try {
    // 현재 사용자 정보 가져오기
    const { data: userData, error: userError } = await supabase
      .from('user_profile')
      .select('rating, wins, loses')
      .eq('user_uuid', userId)
      .single();

    const { data: opponentData, error: opponentError } = await supabase
      .from('user_profile')
      .select('rating')
      .eq('user_uuid', opponentId)
      .single();

    if (userError || !userData || opponentError || !opponentData) {
      console.error('사용자 정보 가져오기 오류:', userError || opponentError);
      return;
    }

    // 새로운 ELO 레이팅 계산
    const newRating = calculateEloRating(
      userData.rating,
      opponentData.rating,
      won
    );

    // 승패 카운트 업데이트
    const updates = {
      rating: newRating,
      wins: userData.wins + (won ? 1 : 0),
      loses: userData.loses + (won ? 0 : 1),
    };

    await supabase.from('user_profile').update(updates).eq('user_uuid', userId);

    console.log(
      `${userId} 레이팅 업데이트: ${userData.rating} → ${newRating} (${
        won ? '승리' : '패배'
      })`
    );
  } catch (error) {
    console.error('사용자 통계 업데이트 오류:', error);
  }
};

// battles 테이블에 경기 결과 저장
const saveBattleResult = async (
  agreePlayerId: string,
  disagreePlayerId: string,
  winnerId: string,
  subjectId: string,
  discussionLog: DiscussionLogEntry[],
  aiResult: AIEvaluationResult
) => {
  try {
    const battleData = {
      player1_uuid: agreePlayerId, // 찬성측
      player2_uuid: disagreePlayerId, // 반대측
      subject_id: subjectId,
      winner_uuid: winnerId,
      log: JSON.stringify(discussionLog),
      result: JSON.stringify(aiResult),
    };

    const { error } = await supabase.from('battles').insert([battleData]);

    if (error) {
      console.error('경기 결과 저장 오류:', error);
    }
    // else {
    //   console.log('경기 결과가 성공적으로 저장되었습니다.');
    // }
  } catch (error) {
    console.error('경기 결과 저장 중 오류:', error);
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

    // 1단계로 진행 - 찬성측 대표발언
    battleStates[roomId].stage = 1;
    startTurnTimer(roomId, finalAgreePlayer.userId);
    // console.log('1단계 진행 - 찬성측 대표발언');
    io.to(roomId).emit('turn_info', {
      currentPlayerId: finalAgreePlayer.userId,
      stage: 1,
      message: `찬성측 ${finalAgreePlayer.displayname}님의 대표발언 차례입니다.`,
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

      // 1단계로 진행 - 찬성측 대표발언
      battleStates[roomId].stage = 1;
      // console.log('1단계 진행 - 찬성측 대표발언');
      io.to(roomId).emit('turn_info', {
        currentPlayerId: finalAgreePlayer.userId,
        stage: 1,
        message: `찬성측 ${finalAgreePlayer.displayname}님의 대표발언 차례입니다.`,
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

      // 메시지 브로드캐스트
      const sender = userId === state.agreePlayer.userId ? 'pro' : 'con';
      io.to(roomId).emit('new_message', { userId, message, sender });

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
      startTurnTimer(roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 2,
        message: `반대측 ${state.disagreePlayer.displayname}님의 대표발언 차례입니다.`,
        stageDescription: '반대측 대표발언',
      });
      break;

    case 3: // 반대측 질문
      startTurnTimer(roomId, state.disagreePlayer.userId);
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
      startTurnTimer(roomId, state.agreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 4,
        message: `찬성측 ${state.agreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '찬성측 답변 및 질문',
      });
      break;

    case 5: // 반대측 답변 및 질문
      startTurnTimer(roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 5,
        message: `반대측 ${state.disagreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '반대측 답변 및 질문',
      });
      break;

    case 6: // 찬성측 답변 및 질문
      startTurnTimer(roomId, state.agreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 6,
        message: `찬성측 ${state.agreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '찬성측 답변 및 질문',
      });
      break;

    case 7: // 반대측 답변
      startTurnTimer(roomId, state.disagreePlayer.userId);
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 7,
        message: `반대측 ${state.disagreePlayer.displayname}님의 답변 차례입니다.`,
        stageDescription: '반대측 답변',
      });
      break;

    case 8: // 찬성측 최종발언
      startTurnTimer(roomId, state.agreePlayer.userId);
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
      startTurnTimer(roomId, state.disagreePlayer.userId);
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
    "good": "잘한 점에 대한 상세한 설명",
    "bad": "개선점에 대한 상세한 설명"
  },
  "disagree": {
    "score": 점수(0-100),
    "good": "잘한 점에 대한 상세한 설명", 
    "bad": "개선점에 대한 상세한 설명"
  },
  "winner": "${state.agreePlayer.userId}" 또는 "${state.disagreePlayer.userId}"
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

    // 기존 battle_result 이벤트도 유지 (DB 저장용)
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
  } catch (error) {
    console.error('AI 평가 오류:', error);
    io.to(roomId).emit('battle_error', 'AI 채점 중 오류가 발생했습니다.');
  }
};
