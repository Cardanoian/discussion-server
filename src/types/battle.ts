import { Subject } from './database';

export interface Player {
  socketId: string;
  userId: string;
  displayname: string;
  isReady: boolean;
  position?: 'agree' | 'disagree';
  role: 'player' | 'spectator' | 'referee';
  rating: number;
  wins: number;
  loses: number;
  discussionViewReady?: boolean;
}

export interface DiscussionLogEntry {
  userId: string;
  message: string;
  stage: number;
}

export interface MessageEntry {
  sender: 'system' | 'judge' | 'agree' | 'disagree';
  text: string;
  timestamp?: number;
}

export interface AIEvaluationResult {
  agree: {
    score: number;
    good: string;
    bad: string;
  };
  disagree: {
    score: number;
    good: string;
    bad: string;
  };
  winner: string;
}

export interface PlayerTimer {
  totalTimeUsed: number; // 전체 사용 시간 (밀리초)
  roundTimeUsed: number; // 현재 라운드 사용 시간
  penaltyPoints: number; // 감점 점수 (3점씩 누적)
  penaltyCount: number; // 감점 횟수
  isOvertime: boolean; // 연장시간 사용 중인지
  overtimeStarted?: number; // 연장시간 시작 시점
}

export interface BattleState {
  [roomId: string]: {
    stage: number; // 0-10 단계
    discussionLog: DiscussionLogEntry[];
    messages: MessageEntry[]; // 모든 메시지 (시스템, 심판, 플레이어)
    players: Player[];
    subject: Subject;
    agreePlayer: Player;
    disagreePlayer: Player;
    timers: {
      [userId: string]: PlayerTimer;
    };
    currentTurnStartTime?: number; // 현재 턴 시작 시간
    roundTimeLimit: number; // 라운드별 시간 제한 (2분 = 120000ms)
    totalTimeLimit: number; // 전체 시간 제한 (5분 = 300000ms)
    overtimeLimit: number; // 연장시간 (30초 = 30000ms)
    penaltyPoints: number; // 감점 점수 (3점)
    maxPenaltyPoints: number; // 18점 (자동 패배 기준)
    isGameEndedByPenalty: boolean; // 감점으로 인한 게임 종료 여부
    serverTimerInterval?: NodeJS.Timeout; // 서버 타이머 인터벌
    aiEvaluationResult?: AIEvaluationResult; // AI 채점 결과
    humanRefereeScores?: { agree: number; disagree: number }; // 인간 심판 점수
  };
}
