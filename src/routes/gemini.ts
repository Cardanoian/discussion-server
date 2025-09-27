import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../supabaseClient';

// Express Request 타입 확장
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

const router = express.Router();

// 메시지 타입 정의
interface DiscussionMessage {
  sender: 'agree' | 'disagree' | string;
  text: string;
}

// Gemini API 클라이언트 초기화
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY가 설정되지 않았습니다.');
}
const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// 사용자 인증 미들웨어
const authenticateUser = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
    }

    const token = authHeader.substring(7);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('인증 오류:', error);
    res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
  }
};

// 근거 생성 API
router.post(
  '/generate-arguments',
  authenticateUser,
  async (req: express.Request, res: express.Response) => {
    try {
      const { subject, existingReasons, isAgainst } = req.body;

      if (!subject) {
        return res.status(400).json({ error: '토론 주제가 필요합니다.' });
      }

      if (!GEMINI_API_KEY) {
        return res
          .status(500)
          .json({ error: 'Gemini API 키가 설정되지 않았습니다.' });
      }

      const existingReasonsText =
        existingReasons?.filter((r: string) => r.trim()).join('\n- ') || '';
      const positionText = isAgainst ? '반대' : '찬성';

      const prompt = `
토론 주제: "${subject}"

이 주제에 대한 ${positionText} 입장에서 강력한 논리적 근거 3개를 제시해주세요.
${
  existingReasonsText
    ? `\n기존 근거:\n- ${existingReasonsText}\n\n기존 근거와 중복되지 않는 새로운 근거를 제시해주세요.`
    : ''
}

각 근거는 다음 형식으로 작성해주세요:
- 구체적이고 논리적인 설명
- 실제 사례나 데이터 포함하지 않음
- 상대방이 반박하기 어려운 강력한 논점
- ${positionText} 입장을 뒷받침하는 명확한 논리

말투 가이드라인:
- 청소년이 자연스럽게 사용할 수 있는 높임말을 사용하세요 (예: "~해요", "~이에요")
- 극존칭이나 과도하게 격식적인 표현은 피하세요 (예: "~하겠습니다", "~라고 사료됩니다" 금지)
- 듣는이를 지칭하는 표현을 절대 사용하지 마세요 (예: "존경하는 토론자분들께", "여러분" 등 금지)

응답 형식: 
- 각 근거를 별도의 줄로 구분하여 작성해주세요. 
- 마크다운 형식을 사용하지 말고, 단순 텍스트로 작성해주세요.
- 각 근거의 시작에 '.'과 같은 표시를 절대 달지 말아주세요.
- 근거는 반드시 짧고 간단히 한 문장으로 짧게 적어주세요.
`;

      const response = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });

      const text = response.text;
      if (!text) {
        return res.status(500).json({ error: 'AI 응답을 받을 수 없습니다.' });
      }

      // 응답을 줄 단위로 분리하고 빈 줄 제거
      const generatedArguments = text
        .trim()
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.match(/^[\d\-*•]\s*$/))
        .map((line: string) => line.replace(/^[\d\-*•]\s*/, '').trim())
        .filter((line: string) => line.length > 10); // 너무 짧은 줄 제거

      res.json({ arguments: generatedArguments.slice(0, 3) });
    } catch (error) {
      console.error('AI 근거 생성 오류:', error);
      res
        .status(500)
        .json({ error: 'AI 근거 생성에 실패했습니다. 다시 시도해주세요.' });
    }
  }
);

// 질문/답변 생성 API
router.post(
  '/generate-questions',
  authenticateUser,
  async (req: express.Request, res: express.Response) => {
    try {
      const { subject, reasons, existingQuestions } = req.body;

      if (!subject || !reasons || !Array.isArray(reasons)) {
        return res
          .status(400)
          .json({ error: '토론 주제와 근거가 필요합니다.' });
      }

      if (!GEMINI_API_KEY) {
        return res
          .status(500)
          .json({ error: 'Gemini API 키가 설정되지 않았습니다.' });
      }

      const reasonsText = reasons.filter((r: string) => r.trim()).join('\n- ');
      const existingQuestionsText =
        existingQuestions
          ?.filter(
            (qa: { q: string; a: string }) => qa.q?.trim() || qa.a?.trim()
          )
          .map((qa: { q: string; a: string }) => `Q: ${qa.q}\nA: ${qa.a}`)
          .join('\n\n') || '';

      const prompt = `
토론 주제: "${subject}"

내 주장 근거:
- ${reasonsText}

위 주장에 대해 상대방이 제기할 수 있는 예상 질문 3개와 각각에 대한 효과적인 답변을 작성해주세요. 
마크다운 형식을 사용하지 말고, 단순 텍스트로 작성해주세요.

${
  existingQuestionsText
    ? `\n기존 질문/답변:\n${existingQuestionsText}\n\n기존 질문과 중복되지 않는 새로운 질문을 제시해주세요.`
    : ''
}

각 질문은:
- 상대방이 실제로 제기할 가능성이 높은 반박이나 의문점
- 내 주장의 약점을 파고드는 날카로운 질문

각 답변은:
- 질문에 대한 논리적이고 설득력 있는 응답을 반드시 짧고 간단히 한 문장으로 작성
- 구체적인 근거나 사례는 포함하지 않음
- 상대방을 납득시킬 수 있는 내용

말투 가이드라인:
- 청소년이 자연스럽게 사용할 수 있는 높임말을 사용하세요 (예: "~해요", "~이에요")
- 극존칭이나 과도하게 격식적인 표현은 피하세요 (예: "~하겠습니다", "~라고 사료됩니다" 금지)
- 듣는이를 지칭하는 표현을 절대 사용하지 마세요 (예: "존경하는 토론자분들께", "여러분" 등 금지)

응답 형식:
Q1: [질문1]
A1: [답변1]

Q2: [질문2]
A2: [답변2]

Q3: [질문3]
A3: [답변3]
`;

      const response = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });

      const text = response.text;
      if (!text) {
        return res.status(500).json({ error: 'AI 응답을 받을 수 없습니다.' });
      }

      // Q1:, A1: 패턴으로 파싱
      const qaPairs: { q: string; a: string }[] = [];
      const lines = text
        .trim()
        .split('\n')
        .map((line: string) => line.trim())
        .filter((line: string) => line);

      let currentQ = '';
      let currentA = '';

      for (const line of lines) {
        if (line.match(/^Q\d*:?\s*/i)) {
          if (currentQ && currentA) {
            qaPairs.push({ q: currentQ, a: currentA });
          }
          currentQ = line.replace(/^Q\d*:?\s*/i, '').trim();
          currentA = '';
        } else if (line.match(/^A\d*:?\s*/i)) {
          currentA = line.replace(/^A\d*:?\s*/i, '').trim();
        } else if (currentA) {
          currentA += ' ' + line;
        } else if (currentQ) {
          currentQ += ' ' + line;
        }
      }

      if (currentQ && currentA) {
        qaPairs.push({ q: currentQ, a: currentA });
      }

      res.json({ questions: qaPairs.slice(0, 3) });
    } catch (error) {
      console.error('AI 질문/답변 생성 오류:', error);
      res.status(500).json({
        error: 'AI 질문/답변 생성에 실패했습니다. 다시 시도해주세요.',
      });
    }
  }
);

// 토론 도움 생성 API
router.post(
  '/generate-discussion-help',
  authenticateUser,
  async (req: express.Request, res: express.Response) => {
    try {
      const {
        subject,
        userPosition,
        currentStage,
        stageDescription,
        discussionLog,
        userReasons,
        userQuestions,
        userRating = 1500,
      } = req.body;

      if (!subject || !userPosition || !currentStage || !stageDescription) {
        return res.status(400).json({
          error: '필수 파라미터가 누락되었습니다.',
        });
      }

      if (!GEMINI_API_KEY) {
        return res
          .status(500)
          .json({ error: 'Gemini API 키가 설정되지 않았습니다.' });
      }

      // 언어 수준 가이드라인 함수 (간단한 버전)
      const getLanguageLevelPrompt = (rating: number) => {
        if (rating < 1200) {
          return '- 간단하고 이해하기 쉬운 표현을 사용하세요\n- 복잡한 논리보다는 직관적인 설명을 우선하세요';
        } else if (rating < 1500) {
          return '- 적당한 수준의 논리적 표현을 사용하세요\n- 기본적인 근거와 예시를 포함하세요';
        } else {
          return '- 논리적이고 체계적인 표현을 사용하세요\n- 깊이 있는 분석과 반박을 포함하세요';
        }
      };

      // 토론 로그를 읽기 쉽게 정리
      const formattedLog =
        discussionLog
          ?.filter(
            (msg: DiscussionMessage) =>
              msg.sender === 'agree' || msg.sender === 'disagree'
          )
          .map((msg: DiscussionMessage) => {
            const speaker = msg.sender === 'agree' ? '찬성측' : '반대측';
            return `${speaker}: ${msg.text}`;
          })
          .join('\n') || '';

      // 상대방의 마지막 발언 추출
      const opponentSender = userPosition === 'agree' ? 'disagree' : 'agree';
      const lastOpponentMessage =
        discussionLog
          ?.filter((msg: DiscussionMessage) => msg.sender === opponentSender)
          .slice(-1)[0]?.text || '';

      // 단계별 전략 안내 및 응답 형식 결정
      const getStageInfo = (stage: number) => {
        switch (stage) {
          case 1:
          case 2:
            return {
              strategy:
                stage === 1
                  ? '대표발언 단계입니다. 핵심 주장을 명확하고 강력하게 제시하세요.'
                  : '대표발언 단계입니다. 상대방 주장의 약점을 파악하며 자신의 입장을 명확히 하세요.',
              responseType: 'answer_only',
            };
          case 3:
            return {
              strategy:
                '질문 단계입니다. 상대방 주장과 근거의 허점을 파고드는 질문을 하세요.',
              responseType: 'question_only',
            };
          case 4:
          case 5:
          case 6:
            return {
              strategy:
                '답변 및 질문 단계입니다. 상대방 질문에 논리적으로 답변하고 상대방 주장과 근거의 허점을 파고드는 질문을 하세요.',
              responseType: 'answer_and_question',
            };
          case 7:
            return {
              strategy:
                '답변 단계입니다. 상대방 질문에 설득력 있게 답변하세요.',
              responseType: 'answer_only',
            };
          case 8:
          case 9:
            return {
              strategy:
                '최종발언 단계입니다. 지금까지의 논의를 정리하고 강력한 마무리를 하세요.',
              responseType: 'answer_only',
            };
          default:
            return {
              strategy: '현재 상황에 맞는 적절한 응답을 하세요.',
              responseType: 'answer_only',
            };
        }
      };

      const stageInfo = getStageInfo(currentStage);
      const languageLevelGuide = getLanguageLevelPrompt(userRating);

      // 단계별 프롬프트 생성
      let prompt = `
토론 주제: "${subject}"
당신의 입장: ${userPosition === 'agree' ? '찬성' : '반대'}
현재 단계: ${stageDescription} (${currentStage}단계)
단계별 전략: ${stageInfo.strategy}

당신이 미리 준비한 근거들:
${
  userReasons
    ?.map((reason: string, index: number) => `${index + 1}. ${reason}`)
    .join('\n') || ''
}

당신이 미리 준비한 예상 질문과 답변:
${
  userQuestions
    ?.map(
      (qa: { q: string; a: string }, index: number) =>
        `Q${index + 1}: ${qa.q}\nA${index + 1}: ${qa.a}`
    )
    .join('\n\n') || ''
}

현재까지의 토론 내용:
${formattedLog}

상대방의 마지막 발언: "${lastOpponentMessage}"

위 정보를 바탕으로, 현재 단계에 맞는 효과적인 응답을 작성해주세요.

기본 요구사항:
1. 당신의 입장(${userPosition === 'agree' ? '찬성' : '반대'})에서 응답하세요
2. 현재 단계(${stageDescription})의 목적에 맞게 작성하세요
3. 미리 준비한 근거나 예상 답변을 바탕으로 대답하세요
4. 상대방의 마지막 발언에 대한 적절한 대응을 포함하세요
5. 논리적이고 설득력 있게 작성하세요
6. 감정적이지 않고 객관적인 톤을 유지하세요

말투 및 표현 가이드라인:
- 청소년이 자연스럽게 사용할 수 있는 높임말을 사용하세요
- 극존칭이나 과도하게 격식적인 표현은 피하세요
- 듣는이를 지칭하는 표현을 절대 사용하지 마세요 (예: "존경하는 찬성측 토론자분들께", "토론자 여러분", "~분들께" 등 금지)
- 상대방을 직접 호명하거나 지칭하는 표현도 피하세요
- 자연스럽고 친근한 톤을 유지하되 논리적 근거는 명확히 제시하세요

언어 수준 및 논리적 복잡성 가이드라인:
${languageLevelGuide}
`;

      // 단계별 응답 형식 추가
      if (stageInfo.responseType === 'question_only') {
        prompt += `

응답 형식: 질문만 작성
- 상대방 주장의 약점을 파고드는 날카로운 질문 한 문장을 작성하세요
- "답변:" 없이 질문만 작성하세요
- 질문은 상대방이 답변하기 어려운 핵심적인 내용이어야 합니다`;
      } else if (stageInfo.responseType === 'answer_and_question') {
        prompt += `

응답 형식: 답변 + 질문
- 먼저 상대방의 질문이나 주장에 대한 답변을 한 문장으로 작성하세요
- 그 다음 줄바꿈 후 상대방에게 할 질문을 한 문장으로 작성하세요
- 형식: "[답변 내용]\n[질문 내용]"
- 답변과 질문 모두 간결하고 명확하게 작성하세요`;
      } else {
        prompt += `

응답 형식: 답변만 작성
- 상대방의 주장이나 질문에 대한 답변을 한 문장으로 작성하세요
- 질문 없이 답변만 작성하세요`;
      }

      const response = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });

      const suggestion = response.text?.trim() || '';

      if (!suggestion) {
        return res.status(500).json({ error: 'AI 응답을 받을 수 없습니다.' });
      }

      res.json({ suggestion });
    } catch (error) {
      console.error('AI 토론 도움 요청 오류:', error);
      res.status(500).json({
        error: 'AI 도움 요청 처리 중 오류가 발생했습니다.',
      });
    }
  }
);

export default router;
