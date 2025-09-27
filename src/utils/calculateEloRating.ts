// ELO 레이팅 계산 함수
export const calculateEloRating = (
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
