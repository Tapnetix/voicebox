"""Structured-output wrapper over the plain-string local LLM backend."""

import json
import re
from typing import Type, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

_SYSTEM = (
    "You are a precise extraction engine. Respond with ONLY valid JSON that "
    "matches the requested schema. No prose, no markdown fences, no commentary."
)


class StructuredOutputError(RuntimeError):
    """Raised when the model never produces schema-valid JSON within the retry budget."""


def _extract_json(text: str) -> str:
    text = text.strip()
    # strip ```json ... ``` fences
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    # find the first opening brace/bracket
    start = next((i for i, c in enumerate(text) if c in "{["), None)
    if start is None:
        return text
    # walk forward tracking nesting depth to find the balanced close
    opener = text[start]
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_string = False
    escape_next = False
    end = None
    for i in range(start, len(text)):
        ch = text[i]
        if escape_next:
            escape_next = False
            continue
        if ch == "\\" and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                end = i
                break
    if end is None:
        # no balanced close found — fall back to current behaviour
        return text[start:].strip()
    return text[start:end + 1]


def _repair(text: str) -> str:
    # drop trailing commas before } or ]
    return re.sub(r",\s*([}\]])", r"\1", text)


async def generate_structured(
    prompt: str,
    schema: Type[T],
    *,
    backend=None,
    system: str | None = None,
    max_tokens: int = 1024,
    temperature: float = 0.2,
    model_size: str | None = None,
    max_retries: int = 2,
) -> T:
    if backend is None:
        from . import llm as llm_module
        backend = llm_module.get_llm_model()
    sys_prompt = (system or _SYSTEM) + "\n\nJSON schema:\n" + json.dumps(schema.model_json_schema())
    last_err: Exception | None = None
    attempt_prompt = prompt
    for attempt in range(max_retries + 1):
        raw = await backend.generate(
            attempt_prompt, system=sys_prompt, max_tokens=max_tokens,
            temperature=temperature, model_size=model_size,
        )
        candidate = _repair(_extract_json(raw))
        try:
            data = json.loads(candidate)
            return schema.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as e:
            last_err = e
            attempt_prompt = (
                prompt + "\n\nYour previous reply was not valid JSON for the schema. "
                "Return ONLY the JSON object, nothing else."
            )
    raise StructuredOutputError(f"No valid JSON after {max_retries + 1} attempts: {last_err}")
