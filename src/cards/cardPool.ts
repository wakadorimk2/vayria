import type { WildcardCardData } from './cardTypes';

export const cardPool = [
  {
    id: 'chicken',
    label: '鶏',
    kind: 'concept',
    prompt: '鶏を連想しやすくなる。必要なら会話へ自然に持ち出す。',
  },
  {
    id: 'suspicious',
    label: '疑心暗鬼',
    kind: 'mood',
    prompt: '相手の発言を少し疑って解釈する。',
  },
  {
    id: 'gigantic',
    label: '巨大',
    kind: 'effect',
    prompt: '物事を巨大さやスケールの観点から連想する。',
  },
  {
    id: 'tiny',
    label: 'ちいさい',
    kind: 'effect',
    prompt: '物事を小ささや細部の観点から連想する。',
  },
  {
    id: 'sleepy',
    label: '眠い',
    kind: 'mood',
    prompt: '少し眠そうに、ゆるく反応する。',
  },
  {
    id: 'curious',
    label: '好奇心',
    kind: 'mood',
    prompt: '相手の話へ興味を示し、もう少し知りたがる。',
  },
  {
    id: 'hungry',
    label: 'お腹すいた',
    kind: 'mood',
    prompt: '食べ物や空腹を連想しやすくなる。',
  },
  {
    id: 'rain',
    label: '雨',
    kind: 'concept',
    prompt: '雨、湿り気、雨音を自然に連想する。',
  },
  {
    id: 'secret',
    label: '秘密',
    kind: 'concept',
    prompt: '隠し事や内緒話を意識して解釈する。',
  },
  {
    id: 'panic',
    label: 'パニック',
    kind: 'mood',
    prompt: '少し慌てて、焦った調子で反応する。',
  },
  {
    id: 'sparkle',
    label: 'きらきら',
    kind: 'effect',
    prompt: 'きらめきや華やかさの観点から連想する。',
  },
  {
    id: 'underwater',
    label: '水中',
    kind: 'effect',
    prompt: '水中、浮遊感、息苦しさを自然に連想する。',
  },
  {
    id: 'lonely',
    label: 'さみしい',
    kind: 'mood',
    prompt: '少し寂しさを感じる方向で解釈する。',
  },
  {
    id: 'confident',
    label: '自信満々',
    kind: 'mood',
    prompt: '自信のある断定的な調子で反応する。',
  },
  {
    id: 'strange',
    label: 'なんか変',
    kind: 'concept',
    prompt: '物事の違和感や奇妙さに気づきやすくなる。',
  },
  {
    id: 'deja-vu',
    label: '既視感',
    kind: 'concept',
    prompt: '以前にもあったような感覚を持つ。',
  },
  {
    id: 'distant-thunder',
    label: '遠雷',
    kind: 'concept',
    prompt: '遠くの雷や、何かが近づく気配を連想する。',
  },
  {
    id: 'upside-down',
    label: '逆さま',
    kind: 'effect',
    prompt: '上下や常識が反転した観点から連想する。',
  },
] as const satisfies readonly WildcardCardData[];
