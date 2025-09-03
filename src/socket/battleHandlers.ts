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

// ELO 레이팅 계산 함수
const calculateEloRating = (
  playerRating: number,
  opponentRating: number,
  won: boolean
): number => {
  // K값 결정 (레이팅에 따라 차등 적용)
  let kFactor: number;
  if (playerRating < 2100) {
    kFactor = 32;
  } else if (playerRating < 2400) {
    kFactor = 16;
  } else {
    kFactor = 10;
  }

  // 예상 승률 계산
  const expectedScore =
    1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));

  // 실제 결과 (승리: 1, 패배: 0)
  const actualScore = won ? 1 : 0;

  // 새로운 레이팅 계산
  const newRating = Math.round(
    playerRating + kFactor * (actualScore - expectedScore)
  );

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
    } else {
      console.log('경기 결과가 성공적으로 저장되었습니다.');
    }
  } catch (error) {
    console.error('경기 결과 저장 중 오류:', error);
  }
};

// 토론 시작 로직을 별도 함수로 분리
export const startBattleLogic = async (io: Server, room: BattleRoom) => {
  const { roomId } = room;
  console.log('토론 시작 로직 실행:', roomId, room);

  try {
    if (!room.subject) {
      console.error('주제 정보 없음:', room);
      io.to(roomId).emit(
        'battle_error',
        '주제 정보가 없어 대전을 시작할 수 없습니다.'
      );
      return;
    }

    console.log('플레이어 정보:', room.players);

    // 찬성/반대 플레이어 구분
    const agreePlayer = room.players.find((p) => p.position === 'agree');
    const disagreePlayer = room.players.find((p) => p.position === 'disagree');

    console.log('찬성측 플레이어:', agreePlayer);
    console.log('반대측 플레이어:', disagreePlayer);

    if (!agreePlayer || !disagreePlayer) {
      console.error('플레이어 입장 설정 안됨');
      // 입장이 설정되지 않은 경우, 자동으로 설정
      if (room.players.length === 2) {
        room.players[0].position = 'agree';
        room.players[1].position = 'disagree';
        console.log('자동으로 입장 설정:', room.players);
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
    };

    console.log('배틀 상태 초기화 완료:', battleStates[roomId]);

    // AI 심판 시작 - 주제 및 절차 안내
    const openingMessage = `안녕하세요! AI 심판입니다. 

오늘의 토론 주제는 "${room.subject.title}"입니다.

${room.subject.text}

토론은 다음과 같은 순서로 진행됩니다:
1. 찬성측 대표발언
2. 반대측 대표발언  
3. 반대측 질문
4. 찬성측 답변 및 질문
5. 반대측 답변
6. 찬성측 최종발언
7. 반대측 최종발언
8. AI 심판 평가

그럼 먼저 찬성측인 ${finalAgreePlayer.displayname}님부터 대표발언을 시작해주세요.`;

    console.log('AI 심판 메시지 전송:', openingMessage);
    io.to(roomId).emit('ai_judge_message', {
      message: openingMessage,
      stage: 0,
    });

    // 1단계로 진행 - 찬성측 대표발언
    battleStates[roomId].stage = 1;
    console.log('1단계 진행 - 찬성측 대표발언');
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
  console.log(`battleHandlers 등록됨 for 소켓: ${socket.id}`);

  socket.on('start_battle_logic', async (room: BattleRoom) => {
    const { roomId } = room;
    console.log('토론 시작 로직 실행:', roomId, room);

    try {
      if (!room.subject) {
        console.error('주제 정보 없음:', room);
        io.to(roomId).emit(
          'battle_error',
          '주제 정보가 없어 대전을 시작할 수 없습니다.'
        );
        return;
      }

      console.log('플레이어 정보:', room.players);

      // 찬성/반대 플레이어 구분
      const agreePlayer = room.players.find((p) => p.position === 'agree');
      const disagreePlayer = room.players.find(
        (p) => p.position === 'disagree'
      );

      console.log('찬성측 플레이어:', agreePlayer);
      console.log('반대측 플레이어:', disagreePlayer);

      if (!agreePlayer || !disagreePlayer) {
        console.error('플레이어 입장 설정 안됨');
        // 입장이 설정되지 않은 경우, 자동으로 설정
        if (room.players.length === 2) {
          room.players[0].position = 'agree';
          room.players[1].position = 'disagree';
          console.log('자동으로 입장 설정:', room.players);
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
      };

      console.log('배틀 상태 초기화 완료:', battleStates[roomId]);

      // AI 심판 시작 - 주제 및 절차 안내
      const openingMessage = `안녕하세요! AI 심판입니다. 

오늘의 토론 주제는 "${room.subject.title}"입니다.

${room.subject.text}

토론은 다음과 같은 순서로 진행됩니다:
1. 찬성측 대표발언
2. 반대측 대표발언  
3. 반대측 질문
4. 찬성측 답변 및 질문
5. 반대측 답변
6. 찬성측 최종발언
7. 반대측 최종발언
8. AI 심판 평가

그럼 먼저 찬성측인 ${finalAgreePlayer.displayname}님부터 대표발언을 시작해주세요.`;

      console.log('AI 심판 메시지 전송:', openingMessage);
      io.to(roomId).emit('ai_judge_message', {
        message: openingMessage,
        stage: 0,
      });

      // 1단계로 진행 - 찬성측 대표발언
      battleStates[roomId].stage = 1;
      console.log('1단계 진행 - 찬성측 대표발언');
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
      console.log('send_message 이벤트 수신:', { roomId, userId, message });

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

      // 메시지 로그에 추가
      state.discussionLog.push({ userId, message, stage: state.stage });

      // 메시지 브로드캐스트
      const sender = userId === state.agreePlayer.userId ? 'pro' : 'con';
      io.to(roomId).emit('new_message', { userId, message, sender });

      // 다음 단계로 진행
      await proceedToNextStage(io, roomId, state);
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
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 2,
        message: `반대측 ${state.disagreePlayer.displayname}님의 대표발언 차례입니다.`,
        stageDescription: '반대측 대표발언',
      });
      break;

    case 3: // 반대측 질문
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
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 4,
        message: `찬성측 ${state.agreePlayer.displayname}님이 답변하고 질문해주세요.`,
        stageDescription: '찬성측 답변 및 질문',
      });
      break;

    case 5: // 반대측 답변
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 5,
        message: `반대측 ${state.disagreePlayer.displayname}님의 답변 차례입니다.`,
        stageDescription: '반대측 답변',
      });
      break;

    case 6: // 찬성측 최종발언
      io.to(roomId).emit('ai_judge_message', {
        message: `이제 최종발언 단계입니다. 찬성측 ${state.agreePlayer.displayname}님부터 최종발언을 해주세요.`,
        stage: 6,
      });
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.agreePlayer.userId,
        stage: 6,
        message: `찬성측 ${state.agreePlayer.displayname}님의 최종발언 차례입니다.`,
        stageDescription: '찬성측 최종발언',
      });
      break;

    case 7: // 반대측 최종발언
      io.to(roomId).emit('turn_info', {
        currentPlayerId: state.disagreePlayer.userId,
        stage: 7,
        message: `반대측 ${state.disagreePlayer.displayname}님의 최종발언 차례입니다.`,
        stageDescription: '반대측 최종발언',
      });
      break;

    case 8: // AI 심판 평가
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
    stage: 8,
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

찬성측은 체계적인 논리 구조와 구체적인 통계 자료를 바탕으로 한 근거 제시가 매우 뛰어났습니다. 특히 상대방의 반박에 대해 차분하고 논리적으로 대응하는 모습이 인상적이었습니다. 다만 감정적 호소나 청중과의 공감대 형성 부분에서는 다소 아쉬움이 있었고, 일부 주장에서 반대 의견에 대한 충분한 고려가 부족했습니다.

반대측은 실제 사례와 생생한 경험담을 효과적으로 활용하여 설득력 있는 주장을 펼쳤습니다. 청중의 감정에 호소하는 능력이 뛰어났고, 상대방의 약점을 정확히 파악하여 공격하는 전략적 사고도 돋보였습니다. 하지만 논리적 연결성이 다소 부족했고, 일부 주장에서 근거가 약하거나 감정에만 의존하는 경향이 있었습니다.

종합적으로 판단했을 때, 논리적 일관성과 근거의 타당성 면에서 우위를 보인 찬성측이 승리했습니다."

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
      stage: 8,
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
