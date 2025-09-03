import { Subject } from './database';

export interface Player {
  socketId: string;
  userId: string;
  displayname: string;
  isReady: boolean;
  position?: 'agree' | 'disagree';
  rating: number;
  wins: number;
  loses: number;
}

export interface DiscussionLogEntry {
  userId: string;
  message: string;
  stage: number;
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

export interface BattleState {
  [roomId: string]: {
    stage: number; // 0-8 단계
    discussionLog: DiscussionLogEntry[];
    players: Player[];
    subject: Subject;
    agreePlayer: Player;
    disagreePlayer: Player;
  };
}
