import json


def check(image_path, question):
    return json.dumps({
        "ok": True,
        "issues": [],
        "requiredText": [{"text": "Title", "present": True, "exact": True}],
        "styleConsistent": True,
        "hierarchyClear": True,
        "richDetail": True,
        "noForbiddenContent": True,
    })


def malformed(image_path, question):
    return '{"ok":true,"issues":[],"extra":"not allowed"}'
