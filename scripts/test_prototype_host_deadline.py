#!/usr/bin/env python3
"""Deterministic deadline admission check; no browser, GUI or real sleeps."""
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import prototype_gecko_hosting as native


class HostDeadline(unittest.TestCase):
    def test_synchronous_stages_cannot_turn_late_status_green(self):
        for phase in ('poll', 'queue', 'ack', 'predicate', 'none'):
            with self.subTest(phase=phase):
                now = [0.0]

                def advance(stage):
                    if phase == stage:
                        now[0] = 1.0  # Reaching the deadline is already late.

                def get(timeout):
                    self.assertGreater(timeout, 0)
                    advance('queue')
                    return {'event': 'status'}

                def predicate(value):
                    advance('predicate')
                    return True

                host = native.Host.__new__(native.Host)
                host.__dict__.update(work=Path('.'), queue=SimpleNamespace(get=get),
                    space_broker=SimpleNamespace(poll=lambda: advance('poll'),
                        received=lambda value: advance('ack')))
                with patch.object(native.time, 'monotonic', lambda: now[0]):
                    if phase == 'none':
                        self.assertEqual(host.wait('status', predicate, timeout=1), {'event': 'status'})
                    else:
                        with self.assertRaises(TimeoutError):
                            host.wait('status', predicate, timeout=1)


if __name__ == '__main__':
    unittest.main()
