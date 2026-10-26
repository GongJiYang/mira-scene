"""psd2live over its own headless MCP endpoint (`psd2live mcp`), driven from Python.

Why this path instead of `./gradlew run --args="--input x.psd"`: the CLI takes a PSD and derives
everything from it, so a mouth with three exclusive states cannot be expressed - `MOUTH_CLOSE`
and `MOUTH_OPEN` are preset opacity ramps over `ParamMouthOpenY`, i.e. always a cross-fade
(`RigBuilder.kt`, `LayerType.PRESET`). Switch variants (`LayerType.SWITCH`, shared parameter with
different associated ids) and per-keyform opacity only arrive through the editor/MCP operations,
and `settings_update` is the only place `headStrength` is reachable after generation. The MCP
process is started here, used for generate + every export, and stopped in `close()`; it uses its
own workspace store under the run directory and leaves no Gradle daemon behind.

Nothing in psd2live is modified: the endpoint, the operations and the documented `mcp_proxy`
client are used as published.
"""
import atexit
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class LiveError(RuntimeError):
    """An MCP operation failed; `detail` holds the operation's error payload when it had one."""

    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


def _free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _import_client(psd2live_dir):
    """psd2live ships a dependency-free client (mcp_proxy.py) in its root; use it as published."""
    if psd2live_dir not in sys.path:
        sys.path.insert(0, psd2live_dir)
    import mcp_proxy  # noqa: PLC0415 - deliberately late: needs the path above
    return mcp_proxy


class Session:
    """One `psd2live mcp` process and its client."""

    def __init__(self, cfg, store_dir, log=print):
        self.cfg = cfg
        self.env = cfg['env']
        self.store_dir = store_dir
        self.log = log
        self.proc = None
        self.client = None
        self.endpoint = None
        self.token = None
        self.posts = 0
        self.log_path = os.path.join(store_dir, 'mcp.log')
        self._log_handle = None
        self._mcp = None

    # ---------------------------------------------------------------- lifecycle

    def start(self):
        if self.client is not None:
            return self
        os.makedirs(self.store_dir, exist_ok=True)
        port = int((self.cfg.get('step7_live', {}).get('mcp') or {}).get('port') or 0) or _free_port()
        self.token = secrets.token_hex(24)  # 48 chars: the app's allowed token alphabet
        args = (f'mcp --port {port} --token {self.token} --store {self.store_dir} '
                f'--profile {self.profile}')
        env = dict(os.environ)
        env['JAVA_HOME'] = self.env['java_home']
        cmd = ['./gradlew', 'run', '-q', f'--args={args}']
        self.log(f'live: starting psd2live mcp on port {port} (store {self.store_dir})')
        self._log_handle = open(self.log_path, 'w', encoding='utf-8')
        self._log_handle.write('$ cd %s\n$ JAVA_HOME=%s %s\n\n'
                               % (self.env['psd2live_dir'], self.env['java_home'], ' '.join(cmd)))
        self._log_handle.flush()
        self.proc = subprocess.Popen(cmd, cwd=self.env['psd2live_dir'], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1, start_new_session=True)
        deadline = time.time() + float(self.timeout)
        endpoint = None
        printed = []
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    break
                time.sleep(0.05)
                continue
            printed.append(line.rstrip('\n'))
            if line.startswith('endpoint '):
                endpoint = line.split(None, 1)[1].strip()
                break
        if endpoint is None:
            self._terminate()
            raise LiveError('psd2live mcp did not report an endpoint: '
                            + ' | '.join(printed[-6:]))
        self.endpoint = endpoint
        self._mcp = _import_client(self.env['psd2live_dir'])
        self.client = self._mcp.Client(endpoint=endpoint, token=self.token,
                                       timeout=float(self.timeout))
        self._drain_thread = _Drain(self.proc, self._log_handle)
        atexit.register(self.close)
        return self

    def _terminate(self):
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                self.proc.terminate()
            try:
                self.proc.wait(timeout=25)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    self.proc.kill()
                try:
                    self.proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        if self._log_handle is not None:
            self._log_handle.flush()
            self._log_handle.close()
            self._log_handle = None

    def close(self):
        if self.client is not None:
            try:
                self.client.close()
            except Exception:  # noqa: BLE001 - a dead endpoint is what we are cleaning up
                pass
            self.client = None
        self._terminate()
        atexit.unregister(self.close)

    # ---------------------------------------------------------------- plumbing

    @property
    def profile(self):
        return (self.cfg.get('step7_live', {}).get('mcp') or {}).get('profile', 'core')

    @property
    def timeout(self):
        return (self.cfg.get('step7_live', {}).get('mcp') or {}).get('start_timeout_s', 420)

    def call(self, operation, request=None, wait_ms=30000):
        """One operation; a background job is waited for either way."""
        if self.client is None:
            self.start()
        self.posts += 1
        try:
            data, _images = self.client.call(operation, request or {}, wait_ms=wait_ms)
        except self._mcp.McpError as error:
            raise LiveError(f'{operation}: {error}', getattr(error, 'detail', None)) from error
        return data

    def edit(self, operation, **request):
        """A document edit: `state` is filled from the current project, like `mcp_proxy --edit`."""
        request.setdefault('state', self.state())
        return self.call(operation, request)

    def project(self):
        return self.call('workspace_inspect', {'scope': 'project'})

    def state(self):
        return self.project()['state']

    def project_id(self):
        return self.project().get('project_id')

    # ---------------------------------------------------------------- operations

    def import_psd(self, psd_path):
        p = self.project()
        return self.call('project_import_psd', {
            'path': os.path.abspath(psd_path), 'state': p['state'],
            'project_id': p.get('project_id'), 'discard_unsaved': True,
            'request_id': f'import-{os.path.basename(psd_path)}-{int(os.path.getmtime(psd_path))}'})

    def settings(self, changes):
        return self.edit('settings_update', changes=changes)

    def generate(self):
        return self.edit('rig_generate')

    def objects(self):
        """Every rig object: list of {name, target, layerId}."""
        out = []
        offset = 0
        while True:
            page = self.call('workspace_inspect', {'scope': 'objects', 'limit': 64,
                                                   'offset': offset})
            items = page.get('items') or []
            out.extend(items)
            offset += len(items)
            if not items or offset >= int(page.get('total') or 0):
                return out

    def layers(self):
        return _paged(self, 'layers')

    def parameters(self):
        return _paged(self, 'parameters')

    def meshes_of_layer(self, layer_id):
        """Targets of every mesh generated from `layer_id` (its lip ribbons included)."""
        return [o['target'] for o in self.objects()
                if str(o.get('layerId') or '') == layer_id
                or str(o.get('layerId') or '').startswith(f'{layer_id}::')]

    def object_detail(self, target):
        return self.call('workspace_inspect', {'scope': 'objects', 'target': target})

    def opacity_axes(self, targets):
        """Every ParamMouthOpenY value the targets' opacity channel already has a key on."""
        out = set()
        for target in targets:
            try:
                detail = self.object_detail(target)
            except LiveError:
                continue
            for channel in detail.get('channels') or []:
                if channel.get('channel') != 'opacity':
                    continue
                for values in (channel.get('axes') or {}).values():
                    out |= {float(v) for v in values}
        return out

    def author_opacity(self, targets, keys):
        """Write (ParamMouthOpenY, opacity) keys on each mesh target, one atomic edit."""
        changes = []
        for target in targets:
            for value, opacity in keys:
                changes.append({'op': 'set', 'target': target,
                                'key': {'ParamMouthOpenY': float(value)},
                                'channels': {'opacity': float(opacity)}})
        if not changes:
            return {'changes': 0}
        return self.call('keyform_apply', {'state': self.state(), 'changes': changes})

    def export_model(self, out_dir):
        pid = self.project_id()
        return self.call('project_export_model', {
            'state': self.state(), 'output_directory': os.path.abspath(out_dir),
            'project_id': pid, 'request_id': f'model-{_stamp()}'}, wait_ms=30000)

    def export_target(self, target, out_dir, settings=None):
        pid = self.project_id()
        request = {'state': self.state(), 'target': target,
                   'output_directory': os.path.abspath(out_dir),
                   'project_id': pid, 'request_id': f'{target}-{_stamp()}'}
        if settings:
            request['settings'] = {str(k): str(v) for k, v in settings.items()}
        return self.call('project_export_target', request, wait_ms=30000)

    def stop_daemon(self):
        """Kill the Gradle daemon this session's build left and count what is left."""
        env = dict(os.environ)
        env['JAVA_HOME'] = self.env['java_home']
        try:
            subprocess.run(['./gradlew', '--stop'], cwd=self.env['psd2live_dir'], env=env,
                           capture_output=True, timeout=180)
        except Exception:  # noqa: BLE001 - best effort; the count below is the evidence
            pass
        procs = self._gradle_daemons()
        forced = []
        for _ in range(10):
            if not procs:
                break
            time.sleep(1.0)
            procs = self._gradle_daemons()
        for line in procs:
            pid = line.split()[0]
            try:
                os.kill(int(pid), signal.SIGTERM)
                forced.append(pid)
            except (ProcessLookupError, ValueError):
                pass
        if forced:
            time.sleep(1.0)
        procs = self._gradle_daemons()
        return dict(stopped=True, remaining_gradle_daemons=len(procs), processes=procs,
                    forced_pids=forced,
                    mcp_process_alive=bool(self.proc and self.proc.poll() is None))

    @staticmethod
    def _gradle_daemons():
        left = subprocess.run(['pgrep', '-fl', 'GradleDaemon'], capture_output=True, text=True)
        return [ln for ln in left.stdout.splitlines() if ln.strip()]


class _Drain:
    """Keep reading the server's stdout so its pipe never fills; the rest goes to mcp.log."""

    def __init__(self, proc, handle):
        import threading
        self._thread = threading.Thread(target=self._run, args=(proc, handle), daemon=True)
        self._thread.start()

    @staticmethod
    def _run(proc, handle):
        try:
            for line in proc.stdout:
                handle.write(line)
                handle.flush()
        except (ValueError, OSError):
            pass


def _paged(session, scope):
    out = []
    offset = 0
    while True:
        page = session.call('workspace_inspect', {'scope': scope, 'limit': 64, 'offset': offset})
        items = page.get('items') or []
        out.extend(items)
        offset += len(items)
        if not items or offset >= int(page.get('total') or 0):
            return out


def _stamp():
    return '%d-%s' % (int(time.time() * 1000), secrets.token_hex(3))


# --------------------------------------------------------------------- mouth states

def mouth_state_of(value, lo, hi):
    if value < lo:
        return 'closed'
    if value < hi:
        return 'small'
    return 'open'


def mouth_bands(cfg, existing_axes=()):
    """(state, [(ParamMouthOpenY value, opacity)]) for the three exclusive mouth states.

    The preset ramps psd2live gives these layers put their own keys on the opacity channel
    (`MOUTH_OPEN` has one at 0.15 = its teeth-fade value, `MOUTH_CLOSE` one at 0 and 1). A key that
    is left alone interpolates against the authored ones and puts a ramp back - that is exactly how
    the first attempt still showed the open mouth at `ParamMouthOpenY` 0.2 (0.90) and 0.5 (0.31).
    So the authored keys are a dense grid over the whole range, every value the channel already
    has included, and the band edges are pinned a hair apart: the curve is a step.
    """
    mc = cfg['step7_live']['mouth_states']
    e = float(mc.get('epsilon', 0.004))
    step = float(mc.get('grid_step', 0.02))
    lo, hi = [float(v) for v in mc['edges']]
    grid = {0.0, 1.0, lo - e, lo + e, hi - e, hi + e}
    n = int(round(1.0 / step))
    grid |= {round(i * step, 6) for i in range(n + 1)}
    grid |= {round(float(v), 6) for v in existing_axes}
    grid = sorted(grid)
    out = {}
    for state in ('closed', 'small', 'open'):
        out[state] = [(v, 1.0 if mouth_state_of(v, lo, hi) == state else 0.0) for v in grid]
    return out, dict(edges=[lo, hi], epsilon=e, grid_step=step, keys=len(grid))


def author_mouth_states(session, cfg, log=print):
    """Make the three mouth states mutually exclusive through their own opacity channels."""
    mc = cfg['variant_layers']['mouth']
    names = {'closed': mc['close_name'], 'small': mc.get('small_name'), 'open': mc['open_name']}
    by_name = {str(l.get('name')): str(l.get('id')) for l in session.layers()}
    targets_by_state = {}
    for state, layer_name in names.items():
        if not layer_name or layer_name not in by_name:
            targets_by_state[state] = (layer_name, [])
            continue
        targets_by_state[state] = (layer_name, session.meshes_of_layer(by_name[layer_name]))
    existing = set()
    for _layer, targets in targets_by_state.values():
        existing |= session.opacity_axes(targets)
    bands, info = mouth_bands(cfg, existing)
    per_state = {}
    for state, (layer_name, targets) in targets_by_state.items():
        if not targets:
            per_state[state] = dict(layer=layer_name, present=bool(layer_name), targets=[],
                                    note='no mesh generated for this layer')
            continue
        result = session.author_opacity(targets, bands[state])
        axes_after = sorted(self_axes := session.opacity_axes(targets))
        per_state[state] = dict(layer=layer_name, targets=targets,
                                keys=len(bands[state]),
                                opacity_at_probe={str(v): o for v, o in bands[state]
                                                  if v in (0.0, 0.2, 0.33, 0.5, 0.66, 0.8, 1.0)},
                                axes_after=axes_after, changed=len(result.get('changed') or []))
        del self_axes
        log(f'  mouth {state}: {len(targets)} mesh(es), {len(bands[state])} opacity keys '
            f'(probe {per_state[state]["opacity_at_probe"]})')
    return dict(states=per_state, **info,
                mode='exclusive per-state opacity keyforms on ParamMouthOpenY '
                     '(no cross-fade; psd2live CLI presets cannot express this)')


def close(session):
    if session is not None:
        session.close()
