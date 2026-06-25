# `packages/config` 現行仕様

> package directory: `packages/config`
> role: workspace共通TypeScript設定

## `tsconfig.base.json`

全workspaceの基本compiler options:

```text
target                     ES2022
module                     ESNext
moduleResolution           bundler
strict                     true
esModuleInterop            true
skipLibCheck               true
forceConsistentCasing      true
resolveJsonModule          true
isolatedModules            true
declaration                true
declarationMap             true
sourceMap                  true
allowImportingTsExtensions true
noEmit                     true
```

各app/packageの`tsconfig.json`はこの設定をextendし、rootDir、outDir、runtime types等を追加する。

## 特性

- `noEmit: true`なのでTypeScript自体はartifactを出さない
- app buildはVite / Wrangler / Flue CLIが担当
- `skipLibCheck: true`
- bundler module resolutionを前提とする
- `.ts`拡張子付きimportを許可

## package設定

`packages/config`自体にはruntime code、build script、testはない。

## 既知の差分・負債

- declaration optionsと`noEmit`を同時に持つため、通常typecheckではdeclaration artifactを生成しない
- package単位の用途別config分割なし
- test用tsconfigなし
- Node / Worker / browserのruntime差は各workspace側の`types`設定に依存する
