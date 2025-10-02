export const avatarStyles = [
  {
    id: 'realistic',
    name: '사실적',
    description: '사실적인 인물 초상화',
    prompt:
      'Ultra realistic professional headshot portrait of a {character}, studio lighting, clean background',
  },
  {
    id: 'cartoon',
    name: '카툰',
    description: '귀여운 만화 스타일',
    prompt:
      'Cute cartoon avatar of a {character}, Pixar animation style, friendly expression, colorful',
  },
  {
    id: 'anime',
    name: '애니메',
    description: '일본 애니메이션 스타일',
    prompt:
      'Anime style avatar of a {character} character, big expressive eyes, kawaii style, high quality illustration',
  },
  {
    id: '3d-render',
    name: '3D 렌더',
    description: '3D 렌더링 스타일',
    prompt:
      '3D rendered avatar of a {character}, smooth surfaces, soft lighting, modern design',
  },
  {
    id: 'watercolor',
    name: '수채화',
    description: '수채화 예술 스타일',
    prompt:
      'Watercolor painting style avatar of a {character}, soft colors, artistic, portrait',
  },
  {
    id: 'pixel-art',
    name: '픽셀아트',
    description: '8비트 픽셀 스타일',
    prompt:
      '8-bit pixel art avatar of a {character}, retro gaming style, simple colors',
  },
  {
    id: 'minimalist',
    name: '미니멀리스트',
    description: '단순하고 깔끔한 스타일',
    prompt:
      'Minimalist line art avatar of a {character}, simple design, clean lines, modern',
  },
  {
    id: 'fantasy',
    name: '판타지',
    description: '판타지 캐릭터 스타일',
    prompt:
      'Fantasy character avatar of a {character}, magical elements, detailed costume, epic style',
  },
  {
    id: 'cyberpunk',
    name: '사이버펑크',
    description: '미래적 사이버펑크 스타일',
    prompt:
      'Cyberpunk style avatar of a {character}, neon colors, futuristic elements, high tech',
  },
  {
    id: 'oil-painting',
    name: '유화',
    description: '클래식 유화 스타일',
    prompt:
      'Oil painting style portrait avatar of a {character}, classical art, rich colors',
  },
] as const;

export type AvatarStyle = (typeof avatarStyles)[number]['id'];
