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
        isReady: boolean;
    }[];
    subject: Subject | null;
    isFull: boolean;
    battleStarted: boolean;
}
