import { supabase } from '../supabaseClient';
import { DiscussionLogEntry, AIEvaluationResult } from '../types/battle';

// battles 테이블에 경기 결과 저장

export const saveBattleResult = async (
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
