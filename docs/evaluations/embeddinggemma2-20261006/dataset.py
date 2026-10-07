"""Fixed representative notes and real source snippets; not a personal-memory index."""
import ast
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
folder = Path(__file__).parent
docs = []
queries = []

def note(key, text, questions):
    docs.append(dict(id=key, group='memory', text=text))
    for query in questions:
        queries.append(dict(query=query, expected=key, group='memory'))

note('sleep-current', 'Current sleep routine: begin at 21:00. Switch the ceiling lamp off immediately; gradually warm and dim the other bedroom lights until 22:30, then switch them off.', ['When should the overhead lamp go dark during bedtime?', 'Which lights fade rather than turning off immediately at night?'])
note('wake-current', 'Current wake routine: start at 09:00 and smoothly increase bedroom brightness from zero to full intensity over sixty minutes, reaching 100 percent at 10:00.', ['What time does the morning sunrise finish?', 'How long does the gradual morning brightening take?'])
note('voice-primary', 'The preferred primary voice is an expressive calm narrator delivered locally by Chatterbox Nano with reference C. Emotional delivery should be selected intelligently from conversational meaning.', ['Which synthesizer handles expressive narration?', 'How should the assistant decide when to add emotional delivery?'])
note('voice-fallback', 'Fallback speech uses Kokoro Onyx at the accepted faster conversational pace when the primary speech synthesizer fails. This is recovery, not the primary voice.', ['What should speak if the main narrator service breaks?', 'Which backup voice is selected?'])
note('persona-deferred', 'PersonaPlex weights are downloaded, but real-time PersonaPlex inference is deferred until a stronger workstation is available. Do not load it during current voice testing.', ['Why is the downloaded duplex voice model staying unloaded?', 'Should we test PersonaPlex on this machine today?'])
note('video-deferred', 'FreeVideo was downloaded for later experimentation. The low-memory video attempt was deferred after resource limits; unload its model and wait for a stronger PC.', ['What happened to local video generation testing?', 'Which downloaded video project should remain off for now?'])
note('decision-cancelled', 'Decision 2.0 evaluation is finished and integration was cancelled. Avoid spending RAM on a decision worker; reconsider future open decision models later.', ['Should we keep a separate decision model resident?', 'Is the evaluated decision specialist still scheduled for integration?'])
note('capture-off', 'SecondBrain automatic personal-life capture is disabled. Proposed memories require review with sources and support correction or deletion before any automatic capture is enabled.', ['Are events in my life automatically recorded?', 'Can the assistant silently save new personal memories?'])
note('brain-structure', 'SecondBrain uses organized Markdown folders for Daily, Areas, Projects, People, Preferences, Decisions and Commitments. Relevant evidence is retrieved selectively instead of loading every file.', ['Where should relationships and commitments be organized?', 'Does memory retrieval need the entire folder in each prompt?'])
note('dream-review', 'Dream produces reviewable memory-maintenance proposals with evidence, ledger records and recovery. Automatic scheduled Dream publication and self-heal repair remain disabled.', ['May overnight memory consolidation apply edits automatically?', 'How is memory consolidation reviewed before publication?'])
note('movie-dynamic', 'Movie themes use a reusable dim palette researched for the current film or show, with slow staggered colour movement among bedroom bulbs, ceiling and PC RGB when included.', ['How should a television theme move across room colours?', 'What makes the themed movie lighting reusable?'])
note('cinematic', 'Cinematic lighting includes the ceiling and combines dim warm white with orange and amber, like a soft cinema atmosphere.', ['Which static mode uses warm white and orange including overhead light?', 'What palette belongs to cinematic lighting?'])
note('romantic', 'The intimate lighting mode includes ceiling light, red and shades of purple, with calm staggered transitions on a one-minute colour cycle.', ['Which moving mode combines red and purple?', 'How often should the romantic colour cycle advance?'])
note('thermal', 'Thermal warning policy: amber when CPU reaches 85 Celsius or GPU reaches 80; red when CPU reaches 95 or GPU reaches 85. Send phone alerts and restore the prior mood after cooling.', ['What are the amber warning temperatures for each processor?', 'When should the PC lighting turn red and notify the phone?'])
note('ha-vm', 'Home Assistant OS runs locally in VirtualBox with 2048 MiB memory and two virtual processors. Reliable startup and avoiding host sleep are important for continuous bulb control.', ['How much memory is reserved for the smart-home virtual machine?', 'How many virtual processors does the Home Assistant guest use?'])
note('matter-network', 'Four Linkind A19 RGBTW bulbs use Matter over Wi-Fi on 2.4 GHz. The PC may use 5 GHz if both radios reach the same local network; these bulbs do not require a Thread border router.', ['Must the computer use the same Wi-Fi frequency as the bulbs?', 'Do these Linkind lamps need a Thread border router?'])
note('health', 'Samsung Health data reaches Home Assistant through Health Connect and companion sensors. Check measurement freshness; sleep records cannot be assumed present until the source actually supplies them.', ['How do we check whether the health dashboard readings are recent?', 'Can a missing sleep record be inferred from watch connection alone?'])
note('remote-cancelled', 'The second PC is no longer needed for Raya testing. Stop using the remote SSH testing workflow and run acceptance on the primary PC.', ['Should the old laptop still be used for integration acceptance?', 'Is remote testing on the second machine still required?'])
note('routing', 'Use a faster local model for ordinary conversation and a stronger coding model for implementation and review. Heavy jobs queue and unload models so conversation retains resource headroom.', ['How should normal chat and difficult code review choose models?', 'What should heavy background work do to leave room for conversation?'])
note('jobs', 'Raya supports jobs, routines, goals and project work as well as voice conversation. Worker activity should show task, progress, model and a working cancellation control.', ['Is the assistant only for chatting and lighting?', 'What information should a running job show?'])

distractors = {
    'sleep-old': 'Archived original sleep plan: all four bulbs, including ceiling, gradually fade from 21:00 to 22:30. Superseded by the current ceiling-off-at-start policy.',
    'wake-old': 'Archived proposal: wake lighting is a manually selected bright scene. Superseded by the current one-hour sunrise schedule.',
    'voice-old': 'Archived early preference: af_heart was liked before selecting Onyx and later expressive Chatterbox narration.',
    'capture-future': 'Future proposal only: continuously log daily events automatically once reviewed policies and permission controls are ready. Not enabled.',
    'thermal-test': 'Simulated TEST amber and red temperature alerts were sent successfully without intentionally heating the hardware.',
    'video-ad': 'An experimental four-second Eden marketing clip was requested. This request did not establish successful video inference.',
    'cpu-cool': 'An idle hardware screenshot showed GPU 34 Celsius and system temperature 37 Celsius; these historical readings are not current telemetry.',
    'browser-job': 'A browser worker may search sources and extract a colour palette. Browser execution and memory embeddings are different services.',
    'backup': 'Backups preserve Home Assistant configuration, local service manifests and SecondBrain notes. Restoration requires clear instructions and verified saved archives.',
    'token': 'The Home Assistant credential is held in secure storage. The lighting adapter limits allowed devices and modes; credential text must not appear in notes.',
    'context': 'Conversation summaries and retrieved memories leave room for current tasks. An embedding model does not enlarge the generation model context limit.',
    'cloud-off': 'Cloud workers and their reserved tasks were released. Do not assign new work to cancelled cloud workers.',
}
for key, text in distractors.items():
    docs.append(dict(id=key, group='distractor', text=text))

base = root/'packages/kilo-vscode/script/memory'
specs = [
    ('service/notes.py', 'digest', ['Find the helper that computes a SHA256 hash of raw bytes.', 'Where is note content fingerprinted using hashlib?']),
    ('service/notes.py', 'atomic', ['Find the note writer that publishes through a temporary file and replaces the target.', 'Which function makes a saved note replacement atomic?']),
    ('service/notes.py', 'current', ['Find the code that reads current note bytes and validates UTF-8 and the writer size limit.', 'Where is a missing note returned as None before applying changes?']),
    ('service/policy.py', 'restricted', ['Find the policy check for sensitive filenames.', 'Which function detects paths that should be excluded from memory indexing?']),
    ('service/index.py', 'remaining', ['Find the deadline and cancellation check before continuing an index operation.', 'Where does an indexing operation refuse to run after its time budget expires?']),
    ('service/index.py', 'tokens', ['Find the function counting text tokens with the cached tokenizer.', 'Where is the tokenizer used to measure a text input?']),
    ('service/index.py', 'semantic', ['Find the function removing Markdown link destinations before semantic matching.', 'Which helper simplifies Markdown text for semantic comparisons?']),
    ('service/index.py', 'headings', ['Find the scanner that hides fenced-code headings from live Markdown sections.', 'Which code tracks backtick and tilde fences while looking for section headings?']),
    ('service/index.py', 'address', ['Find relative Markdown link resolution with a source folder.', 'Where is a linked note path resolved relative to its containing document?']),
    ('service/index.py', 'links', ['Find extraction of ordinary Markdown links outside code fences.', 'Which function collects linked references from a note?']),
    ('retrieval/validation.py', 'fields', ['Find JSON parsing code that rejects duplicate object keys.', 'Which helper refuses repeated field names in a received object?']),
    ('retrieval/validation.py', 'canonical', ['Find bounded deterministic serialization with sorted JSON keys.', 'Where is canonical JSON produced before computing a request fingerprint?']),
]
for filename, name, questions in specs:
    path = base/filename
    raw = path.read_text(encoding='utf-8')
    matches = [item for item in ast.walk(ast.parse(raw)) if isinstance(item, ast.FunctionDef) and item.name == name]
    assert len(matches) == 1, (filename, name)
    item = matches[0]
    text = '\n'.join(raw.splitlines()[item.lineno-1:item.end_lineno])
    key = 'code-'+name
    docs.append(dict(id=key, group='code', title=filename, text=text, source_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    for query in questions:
        queries.append(dict(query=query, expected=key, group='code'))

value = dict(scope='Fixed representative synthetic setup notes plus real source function snippets. Archived distractors are deliberate. This is not live personal-memory indexing or general benchmark certification.', documents=docs, queries=queries)
(folder/'dataset.json').write_text(json.dumps(value, indent=2), encoding='utf-8')
print(json.dumps(dict(documents=len(docs), queries=len(queries), memory_queries=40, code_queries=24)))
