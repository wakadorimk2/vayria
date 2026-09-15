<h1 align="center">Vayria</h1>

<p align="center"><strong>カードを選ぶ。会話が変わる。</strong></p>

<p align="center">Vayria（ヴェイリア）は、会話やカードの交換に、声・表情・動きで応えるAIキャラクターです。</p>

<p align="center">An AI character that responds to conversation and card exchanges through voice, expressions, and movement.</p>

<p align="center"><a href="https://vayria.me/"><strong>公式サイト — vayria.me</strong></a></p>

<p align="center">
  <a href="docs/images/vayria-kv-poster.jpg"><img src="docs/images/vayria-kv-poster.jpg" width="420" alt="カードを差し出すVayria。『カードを選ぶ。会話が変わる。』と書かれたキービジュアル"></a>
</p>

<p align="center">立ち絵：wakadori／キービジュアルデザイン：共同制作</p>

## できること

声や文字で話しかけると、Vayriaが音声と表情で応えます。
マイクを使わず、文字やカードだけでもやり取りできます。

カードは、手札とVayriaの「脳内」から1枚ずつ選んで交換します。
交換したカードは次の返答に影響します。
返答にどのカードが作用したかは、画面で確認できます。

開発中のため、ここに記載した機能と公式サイトでの提供状況は異なる場合があります。

## 作っている理由

「AIだけでキャラクターが成立するのか知りたい」と思って作っています。
会話ができることと、キャラクターとして成立することは、どこまで同じなんだろう。

確かめたいのは、返答の内容だけではありません。
話し始めるまでの間や、声と表情、動きも含めて、キャラクターとしてどう感じられるかを見ています。

何をもって「成立した」とするのか。そこも含めて、実際に作って確かめています。

## 開発資料

- [開発・運用ガイド](docs/development-guide.md) — セットアップ、検証、公開版の運用、展示準備
- [Performer Runtimeの設計](docs/architecture/performer-runtime.md) — キャラクターの振る舞いを支える構成

[![CI: mainのpush実行結果](https://github.com/wakadorimk2/vayria/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/wakadorimk2/vayria/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)
