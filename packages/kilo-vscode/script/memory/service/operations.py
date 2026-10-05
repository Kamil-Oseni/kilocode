"""Metadata-only Memory operation journal under an explicitly selected namespace."""
from namespace import Namespace
from retirement import canonical, certificate, fingerprint, hex


class Journal:
    def __init__(self, root, principal, generations, epoch, release):
        if not hex(epoch, 32) or not hex(release, 64):
            raise ValueError('Selected Memory identity differs.')
        self.namespace = Namespace(root, principal, generations)
        self.epoch = epoch
        self.release = release
        if any(self.namespace.root.joinpath('Requests').iterdir()):
            raise ValueError('Prior Memory operations require their original owner.')
        self.folder = self.namespace.folder('Requests', epoch)

    def reserve(self, request, kind, body):
        if not hex(request, 32) or kind not in ('search', 'sync'):
            raise ValueError('Memory operation identity differs.')
        value = {'format': 'raya.memory.operation.v1', 'request': request,
                 'owner_epoch': self.epoch, 'selected_release_sha256': self.release,
                 'kind': kind, 'request_sha256': fingerprint(body), 'status': 'pending'}
        self.namespace.publish(self.folder, request+'-pending.json', canonical(value))
        return value

    def complete(self, pending, result, outcome, proofs):
        if pending['owner_epoch'] != self.epoch or pending['selected_release_sha256'] != self.release:
            raise ValueError('Original Memory operation selection differs.')
        if outcome not in ('completed', 'failed', 'cancelled'):
            raise ValueError('Memory operation outcome differs.')
        refs = []
        requests = set()
        for item in proofs:
            if item['request'] in requests:
                raise ValueError('Duplicate downstream request certificate.')
            requests.add(item['request'])
            refs.append(certificate(item, item['request'], item['owner_epoch'],
                                    item['selected_release_sha256'], item['request_sha256']))
        value = dict(pending, status='terminal', operation_outcome=outcome,
                     downstream=refs)
        if outcome == 'completed':
            value['result_sha256'] = fingerprint(result)
            if pending['kind'] == 'sync':
                names = {'files', 'chunks', 'new_embeddings', 'reused_embeddings'}
                if not isinstance(result, dict) or set(result) not in (names, names | {'rebuilt'}) or any(type(result[name]) is not int or result[name] < 0 for name in names) or ('rebuilt' in result and result['rebuilt'] is not True):
                    raise ValueError('Memory aggregate result differs.')
                value['counts'] = {name: result[name] for name in names}
                if 'rebuilt' in result:
                    value['rebuilt'] = True
        value['receipt_sha256'] = fingerprint(value)
        self.namespace.publish(self.folder, pending['request']+'-terminal.json', canonical(value))
        return value
