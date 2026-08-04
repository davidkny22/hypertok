import hashlib
import base64
import json
import struct
import sys

import tiktoken


def digest_ids(ids):
    digest = hashlib.sha256()
    for token_id in ids:
        digest.update(struct.pack("<I", token_id))
    return digest.hexdigest()


request = json.load(sys.stdin)
encoding = tiktoken.get_encoding("o200k_base")
rows = []
for workload in request["workloads"]:
    if "path" in workload:
        with open(workload["path"], "rb") as source:
            text = source.read().decode("utf-8")
    else:
        text = base64.b64decode(workload["bytes_base64"]).decode("utf-8")
    ids = encoding.encode_ordinary(text)
    rows.append(
        {
            "workload": workload["id"],
            "bytes": len(text.encode("utf-8")),
            "ids": len(ids),
            "digest": digest_ids(ids),
        }
    )

json.dump({"oracle": "tiktoken", "version": tiktoken.__version__, "rows": rows}, sys.stdout)
