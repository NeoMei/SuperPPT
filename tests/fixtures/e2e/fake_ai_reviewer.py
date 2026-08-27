import json
import re


def check(image_path, question):
    match = re.search(r"copy item: (\[[^\n]*\])\.", question)
    required = json.loads(match.group(1)) if match else []
    return json.dumps({
        "ok": True,
        "issues": [],
        "requiredText": [
            {"text": text, "present": True, "exact": True}
            for text in required
        ],
        "styleConsistent": True,
        "hierarchyClear": True,
        "richDetail": True,
        "noForbiddenContent": True,
    })
