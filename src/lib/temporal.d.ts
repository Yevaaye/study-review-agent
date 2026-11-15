// ts-fsrs 的类型声明引用了 Temporal（ESNext 内置）与 private 字段语法，
// 而本项目 target 为 ES2017 且未启用 ESNext 的 Temporal lib。
// 这里声明一个最小 Temporal 命名空间，避免 ts-fsrs 的 .d.ts 触发 TS2503。
declare namespace Temporal {
  interface Instant {
    toString(): string;
  }
  interface PlainDate {
    toString(): string;
  }
  interface PlainDateTime {
    toString(): string;
  }
  interface ZonedDateTime {
    toString(): string;
  }
  interface Duration {
    toString(): string;
  }
}
