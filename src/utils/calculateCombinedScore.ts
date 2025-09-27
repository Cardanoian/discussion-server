import { AIEvaluationResult } from '../types/battle';

// AI + 인간 심판 점수 통합 계산 함수
export const calculateCombinedScore = (
  aiResult: AIEvaluationResult,
  humanScores: { agree: number; disagree: number }
): AIEvaluationResult => {
  // 가중평균 계산 (AI 40% + 인간 60%)
  const agreeFinalScore = Math.round(
    aiResult.agree.score * 0.4 + humanScores.agree * 0.6
  );
  const disagreeFinalScore = Math.round(
    aiResult.disagree.score * 0.4 + humanScores.disagree * 0.6
  );

  // 0-100 범위 보장
  const agreeScore = Math.max(0, Math.min(100, agreeFinalScore));
  const disagreeScore = Math.max(0, Math.min(100, disagreeFinalScore));

  // 승자 결정 - 최종 점수 기준으로 간단하게
  let finalWinner = aiResult.winner;
  if (agreeScore > disagreeScore) {
    // 찬성측이 이겼을 때 - 찬성측 플레이어 ID 찾기
    finalWinner = aiResult.winner; // 일단 기존 winner 사용, 실제로는 agreePlayer.userId
  } else if (disagreeScore > agreeScore) {
    // 반대측이 이겼을 때 - 반대측 플레이어 ID 찾기
    finalWinner = aiResult.winner; // 일단 기존 winner 사용, 실제로는 disagreePlayer.userId
  }
  // 동점일 때는 AI 결과 그대로 사용
  return {
    agree: {
      score: agreeScore,
      good: `${aiResult.agree.good} (AI: ${aiResult.agree.score}점, 심판: ${humanScores.agree}점)`,
      bad: aiResult.agree.bad,
    },
    disagree: {
      score: disagreeScore,
      good: `${aiResult.disagree.good} (AI: ${aiResult.disagree.score}점, 심판: ${humanScores.disagree}점)`,
      bad: aiResult.disagree.bad,
    },
    winner: finalWinner,
  };
};
