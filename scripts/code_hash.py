#!/usr/bin/env python3
"""Prints a wasm file's NEAR code_hash: base58 of its SHA-256, as `view_account` reports it."""
import hashlib
import sys

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


with open(sys.argv[1], "rb") as f:
    print(base58(hashlib.sha256(f.read()).digest()))
