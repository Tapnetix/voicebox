import pytest
from pydantic import BaseModel

from backend.services.llm_structured import generate_structured, StructuredOutputError


class Item(BaseModel):
    name: str
    n: int


class _FakeLLM:
    def __init__(self, replies):
        self._replies = list(replies)
        self.calls = 0

    async def generate(self, prompt, system=None, max_tokens=512, temperature=0.7,
                        model_size=None, examples=None):
        self.calls += 1
        return self._replies[min(self.calls - 1, len(self._replies) - 1)]


@pytest.mark.asyncio
async def test_clean_json():
    llm = _FakeLLM(['{"name": "Holston", "n": 3}'])
    out = await generate_structured("p", Item, backend=llm)
    assert out.name == "Holston" and out.n == 3
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_fenced_json_is_unwrapped():
    llm = _FakeLLM(['```json\n{"name": "A", "n": 1}\n```'])
    out = await generate_structured("p", Item, backend=llm)
    assert out.n == 1


@pytest.mark.asyncio
async def test_trailing_comma_repaired():
    llm = _FakeLLM(['{"name": "A", "n": 1,}'])
    out = await generate_structured("p", Item, backend=llm)
    assert out.name == "A"


@pytest.mark.asyncio
async def test_retries_then_succeeds():
    llm = _FakeLLM(["totally not json", '{"name":"B","n":2}'])
    out = await generate_structured("p", Item, backend=llm, max_retries=2)
    assert out.n == 2
    assert llm.calls == 2


@pytest.mark.asyncio
async def test_unrecoverable_raises():
    llm = _FakeLLM(["nope", "still nope", "nope again"])
    with pytest.raises(StructuredOutputError):
        await generate_structured("p", Item, backend=llm, max_retries=2)
