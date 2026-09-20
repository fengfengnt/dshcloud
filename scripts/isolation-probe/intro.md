这份报告把 [CONTAINER-ISOLATION-PAPER](CONTAINER-ISOLATION-PAPER.md) 的核心结论拿到**两台完全不同的宿主**上各重测了一遍。
目的不是复现论文的数字，而是分清两件事：哪些结论**不随宿主变**，哪些是**那一台机器的属性**。

两台机器：

- **mac（M1 / Docker Desktop）** —— linuxkit 内核 6.10.14，引擎 28.0.1，8 核 7.7 GiB，无 KVM，没有 lxcfs、没有 runsc。
  它代表「开发机」这一类宿主。
- **linux（Debian 13）** —— 内核 6.12.43，引擎 29.8.0，4 核 7.8 GiB，无 KVM 但有 lxcfs、且引擎里配了 runsc。
  它代表「普通 Linux 服务器」这一类宿主。

结果按论文自己的三层排：**隔离**（谁够得着谁）、**加固**（容器能做什么）、**信息隐藏**（容器能读出宿主的什么）。
每一项左右两列是两台机器各自的实测值与结论，最后一列只做一件事 —— 指出**两台是否一致**，不做额外推断。

三处读法上的提醒：

1. **未测不等于通过。** 某一列写着「未测」的项，只说明**这台机器上测不了**，不代表它安全或不安全。
   为什么测不了，写在每一项的注里，也在 §四 汇总。
2. **两台不同的地方才是重点。** 论文 §4 的第三条纪律是「换运行时或宿主后，既有结论一律重测」——
   标着「两台结论不同」的行，就是这条纪律实际起了作用的地方。用一台机器的结论去推另一台，会错。
3. **§二 第 3 行会推翻一个常见假设。** `--storage-opt size=` 看起来设了配额，实测两台都**不拦**：
   选项被引擎接受、写盘照样写满。这类「设了不生效」比报错更危险，因为它让配置看起来是对的。

复现（两台各跑一次，再合成这份报告）：

```bash
scripts/isolation-probe.sh --label "mac (M1)" --save mac.tsv
ssh <linux 宿主> 'bash isolation-probe.sh --label "linux (Debian 13)" --with-quota --save linux.tsv'
scripts/isolation-probe.sh --merge mac.tsv linux.tsv \
  --labels "mac（M1 / Docker Desktop）","linux（Debian 13）" \
  --intro scripts/isolation-probe/intro.md \
  --out docs/CONTAINER-ISOLATION-TEST-REPORT.md
```

`--with-quota` 会在**那台宿主上**建一个一次性 loop 设备与 XFS 池、写 400 MiB 左右、跑完卸掉；
不加这个开关，第 3b 行就是未测。探针不碰宿主上已有的部署：自己的容器全部打 `isoprobe=1` 标签，退出时按标签删。
