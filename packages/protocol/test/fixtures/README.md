# 测试夹具

## `noise-ik-25519-aesgcm-sha256.json`

Noise 官方测试向量里 `protocol_name === "Noise_IK_25519_AESGCM_SHA256"` 的全部条目（1 条，带 prologue，2 条握手消息加 4 条传输消息），给 `test/secure-channel-vectors.test.ts` 用（devices-2-secure-channel 第 5 节）。

- 来源：cacophony（Noise 的 Haskell 实现）的 `vectors/cacophony.txt`，https://github.com/haskell-cryptography/cacophony/blob/master/vectors/cacophony.txt ，该文件最后一次改动是提交 `18b7348c54fd61fcd0c220298883de0d09c8364d`（2018-12-16）。
- 抽取：2026-11-01，按 `protocol_name` 精确匹配，字段原样保留，只去掉了其他套件的条目；抽取时整份文件的 SHA-256 是 `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`。
- 许可：cacophony 以 Unlicense 发布（公有领域），https://github.com/haskell-cryptography/cacophony/blob/master/LICENSE 。

向量的消息 1 是纯 Noise 消息；vonvon 的消息 1 在前面多一个版本字节 `0x01`，测试里比较时去掉它。传输消息的密文对应 vonvon 帧去掉前 8 字节计数器之后的部分。
