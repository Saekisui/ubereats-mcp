#!/bin/sh
# 把 adapters/ubereats/ 复制到 ~/.opencli/clis/ubereats/（OpenCLI 不认软链目录，只认真目录里的真文件）。改完 adapter 跑一下。
set -e
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.opencli/clis/ubereats"
cp adapters/ubereats/*.js "$HOME/.opencli/clis/ubereats/"
echo "synced → ~/.opencli/clis/ubereats/"
