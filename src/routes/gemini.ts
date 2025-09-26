import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '../supabaseClient';

const router = express.Router();

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

export default router;
