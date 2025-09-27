import { supabase } from '../supabaseClient';
import { calculateEloRating } from './calculateEloRating';

// 사용자 통계 업데이트 함수

export const updateUserStats = async (
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
