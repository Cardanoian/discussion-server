export type UserProfile = {
  user_uuid: string;
  display_name: string;
  rating: number;
  wins: number;
  loses: number;
};

export type Doc = {
  id: number;
  user_uuid: string;
  subject_id: string;
  against: boolean;
  reasons: string[];
  questions: { q: string; a: string }[];
};

export type BattleLog = {
  id: number;
  user_uuid: string;
  subject_id: string;
  log: string; // JSON format
};

export type Subject = {
  uuid: string;
  title: string;
  text: string;
};

export type BattleRoom = {
  roomId: string;
  players: {
    socketId: string;
    userId: string;
    displayname: string;
    isReady: boolean;
    position?: 'agree' | 'disagree'; // 찬성/반대 입장 추가
    discussionViewReady?: boolean; // discussionView 준비 상태 추가
    rating: number;
    wins: number;
    loses: number;
  }[];
  subject: Subject | null;
  isFull: boolean;
  battleStarted: boolean;
};

export type DiscussionMessage = {
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  stage: number;
};

export type BattleState = {
  stage: number;
  discussionLog: DiscussionMessage[];
  players: BattleRoom['players'];
  subject: Subject;
  agreePlayer: BattleRoom['players'][0];
  disagreePlayer: BattleRoom['players'][0];
};

export type BattleStates = {
  [roomId: string]: BattleState;
};
