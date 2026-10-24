"""Snapshot the hydrated Pi chat catalog as Python package data, without a TS runtime."""

import argparse
import json
from pathlib import Path

APIS = {'openai-completions', 'openai-responses', 'openai-codex-responses',
        'anthropic-messages', 'google-generative-ai'}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2] / 'packages/ai/src/providers/data')
    args = parser.parse_args()
    models: list[dict[str, object]] = []
    classifiers: list[dict[str, object]] = []
    for path in sorted(args.source.glob('*.json')):
        for api, entries in json.loads(path.read_text()).items():
            if api == 'typesafe-system-one':
                classifiers.extend({key: value[key] for key in ['id','provider','name','api','baseUrl','compat','headers','input','cost'] if key in value}
                    for value in entries.values() if value.get('type') == 'classifier')
            if api not in APIS:
                continue
            for value in entries.values():
                if value.get('type') != 'chat':
                    continue
                models.append({key: value[key] for key in ['id', 'provider', 'name', 'api', 'baseUrl',
                    'maxTokens', 'cost', 'compat', 'headers', 'input', 'reasoning', 'thinkingLevelMap'] if key in value})
    if not models:
        raise SystemExit('No hydrated Pi chat model catalog found')
    target = Path(__file__).resolve().parents[1] / 'src/amazme_backend/model_catalog.json'
    target.write_text(json.dumps(models, ensure_ascii=False, separators=(',', ':')) + '\n')
    target.with_name('classifier_catalog.json').write_text(json.dumps(classifiers, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{len(models)} Pi chat models written to {target}')


if __name__ == '__main__':
    main()
