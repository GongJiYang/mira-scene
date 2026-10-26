"""Live2D pipeline driver: See-through PSD -> native-resolution rebuild -> psd2live.

Each step writes <out_root>/stepN/metrics.json plus check figures. Run one step with
`pipeline.py step3`, or the whole chain with `pipeline.py all`.
"""
import argparse
import importlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load_config(path=None):
    cfg_path = path or os.path.join(HERE, 'config.json')
    with open(cfg_path, encoding='utf-8') as f:
        cfg = json.load(f)
    base = os.path.dirname(os.path.abspath(cfg_path))
    for key in ('psd', 'original_png'):
        p = cfg['input'][key]
        if not os.path.isabs(p):
            cfg['input'][key] = os.path.abspath(os.path.join(base, p))
    return cfg


def save_config_snapshot(cfg, out_root):
    os.makedirs(out_root, exist_ok=True)
    with open(os.path.join(out_root, 'config.used.json'), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description='See-through PSD -> native PSD -> psd2live pipeline')
    ap.add_argument('steps', nargs='*', default=['all'],
                    help='step3 step4 step5 step6 step7 step8, or "all" (default)')
    ap.add_argument('--config', default=None, help='config.json path')
    ap.add_argument('--out', default=None, help='override output_dir')
    ap.add_argument('--set', action='append', default=[], metavar='KEY=VALUE',
                    help='override a config value, e.g. --set step4_upscale.color_tolerance=30')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args(argv)

    if os.path.abspath(HERE) not in sys.path:
        sys.path.insert(0, os.path.abspath(HERE))

    cfg = load_config(args.config)
    if args.out:
        cfg['output_dir'] = args.out
    for override in args.set:
        key, _, value = override.partition('=')
        node = cfg
        parts = key.split('.')
        for p in parts[:-1]:
            node = node[p]
        try:
            node[parts[-1]] = json.loads(value)
        except json.JSONDecodeError:
            node[parts[-1]] = value

    out_root = cfg['output_dir']
    save_config_snapshot(cfg, out_root)
    log = (lambda *a, **k: None) if args.quiet else print

    chain = ['step3', 'step4', 'step5', 'step6', 'step7', 'step8', 'compare', 'report']
    steps = []
    for s in args.steps:
        for name in (chain if s == 'all' else [s]):
            if name not in steps:
                steps.append(name)
    results = {}
    for name in steps:
        mod = importlib.import_module(f'l2dp.{name}')
        log(f'=== {name} ===')
        results[name] = mod.run(cfg, out_root, log=log)
        log(f'=== {name} done ===')
    return results


if __name__ == '__main__':
    main()
