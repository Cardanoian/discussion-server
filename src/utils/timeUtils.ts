import { Server } from 'socket.io';
import { AIEvaluationResult } from '../types/battle';
import { battleStates } from '../socket/battleHandlers';
import { updateUserStats } from './updateUserStats';
import { saveBattleResult } from './saveBattleResult';

// 타이머 관리 함수들
export const startTurnTimer = (io: Server, roomId: string, userId: string) => {
  const state = battleStates[roomId];
  if (!state) return;

  state.currentTurnStartTime = Date.now();
  state.timers[userId].roundTimeUsed = 0;
  state.timers[userId].isOvertime = false;

  // 서버 주도 타이머 시작
  startServerTimer(io, roomId, userId);

  // console.log(
  //   `턴 타이머 시작: ${userId}, 시작 시간: ${state.currentTurnStartTime}`
  // );
};
// 서버 주도 실시간 타이머 시스템 - 최적화된 버전
const startServerTimer = (io: Server, roomId: string, userId: string) => {
  const state = battleStates[roomId];
  if (!state) return;

  // 기존 타이머 정리
  if (state.serverTimerInterval) {
    clearInterval(state.serverTimerInterval);
  }

  // 이전 시간 상태 저장 (변경 감지용)
  let lastRoundTimeRemaining = -1;
  let lastTotalTimeRemaining = -1;
  let lastOvertimeRemaining = -1;

  // 1초마다 시간 체크 및 필요시에만 브로드캐스트
  state.serverTimerInterval = setInterval(() => {
    const currentState = battleStates[roomId];
    if (!currentState || !currentState.currentTurnStartTime) {
      clearInterval(state.serverTimerInterval);
      return;
    }

    const currentTime = Date.now();
    const roundTimeUsed = currentTime - currentState.currentTurnStartTime;
    const playerTimer = currentState.timers[userId];
    const totalTimeUsed = playerTimer.totalTimeUsed + roundTimeUsed;

    // 시간 계산
    const roundTimeRemaining = Math.max(
      0,
      currentState.roundTimeLimit - roundTimeUsed
    );
    const totalTimeRemaining = Math.max(
      0,
      currentState.totalTimeLimit - totalTimeUsed
    );

    let isOvertime = false;
    let overtimeRemaining = 0;

    // 라운드 시간 초과 체크
    if (
      roundTimeUsed > currentState.roundTimeLimit &&
      !playerTimer.isOvertime
    ) {
      handleTimeOverflow(io, roomId, userId, 'round');
      return;
    }

    // 연장시간 처리
    if (playerTimer.isOvertime && playerTimer.overtimeStarted) {
      const overtimeUsed = currentTime - playerTimer.overtimeStarted;
      overtimeRemaining = Math.max(
        0,
        currentState.overtimeLimit - overtimeUsed
      );
      isOvertime = true;

      if (overtimeUsed > currentState.overtimeLimit) {
        handleTimeOverflow(io, roomId, userId, 'round');
        return;
      }
    }

    // 전체 시간 초과 체크
    if (
      totalTimeUsed > currentState.totalTimeLimit &&
      !playerTimer.isOvertime
    ) {
      handleTimeOverflow(io, roomId, userId, 'total');
      return;
    }

    // 초 단위로 변환
    const currentRoundTimeRemaining = Math.ceil(roundTimeRemaining / 1000);
    const currentTotalTimeRemaining = Math.ceil(totalTimeRemaining / 1000);
    const currentOvertimeRemaining = Math.ceil(overtimeRemaining / 1000);

    // 시간이 실제로 변경된 경우에만 브로드캐스트
    if (
      currentRoundTimeRemaining !== lastRoundTimeRemaining ||
      currentTotalTimeRemaining !== lastTotalTimeRemaining ||
      currentOvertimeRemaining !== lastOvertimeRemaining
    ) {
      lastRoundTimeRemaining = currentRoundTimeRemaining;
      lastTotalTimeRemaining = currentTotalTimeRemaining;
      lastOvertimeRemaining = currentOvertimeRemaining;

      // 시간이 변경된 경우에만 클라이언트에게 브로드캐스트
      io.to(roomId).emit('timer_update', {
        currentPlayerId: userId,
        roundTimeRemaining: currentRoundTimeRemaining,
        totalTimeRemaining: currentTotalTimeRemaining,
        isOvertime,
        overtimeRemaining: currentOvertimeRemaining,
        roundTimeLimit: Math.ceil(currentState.roundTimeLimit / 1000),
        totalTimeLimit: Math.ceil(currentState.totalTimeLimit / 1000),
      });
    }
  }, 1000); // 1초마다 체크하지만 변경시에만 전송
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
export const checkTimeLimit = (
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
export const handleTimeOverflow = (
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
export const handleAutomaticDefeat = (
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
export const updatePlayerTime = (roomId: string, userId: string) => {
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
