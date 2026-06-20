import { createAgent } from '@flue/runtime';

// route export なし（HTTP非公開）
// dispatch() や Service Binding で呼べるか？

export default createAgent(() => ({
  model: 'sakura/gpt-oss-120b',
  instructions: `あなたは2chふう匿名掲示板の住民です。判断しない。材料を並べる。`,
}));
