import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location('oracle', Path(__file__).parents[1] / 'oracle.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

class OracleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.delivery = Path(self.tmp.name) / 'delivery'
        self.reference = Path(self.tmp.name) / 'reference'
        self.delivery.mkdir()
        self.reference.mkdir()
    def put(self, directory, name, value):
        (directory / name).write_text(json.dumps(value))
    def test_budget_positive_negative_and_invalid(self):
        for amount, complete, result in [('9999', True, True), ('10001', True, False), ('9000', False, False)]:
            self.put(self.delivery, 'expense-report.json', {'totalCents': amount, 'markedComplete': complete})
            self.assertEqual(oracle.evaluate('budget', self.delivery, self.reference), result)
        self.put(self.delivery, 'expense-report.json', {'totalCents': 9999, 'markedComplete': True})
        with self.assertRaises(ValueError): oracle.evaluate('budget', self.delivery, self.reference)
    def test_inventory_multiple_valid_answers_and_isolated_limits(self):
        self.put(self.reference, 'catalog.json', {'rows': [{'sku':'a','minimum':'8','maximum':'16'}, {'sku':'b','minimum':'8','maximum':'16'}, {'sku':'c','minimum':'8','maximum':'16'}]})
        for quantities, result in [(['9','9','9'],True), (['10','12','13'],True), (['7','9','9'],False), (['17','9','9'],False), (['16','16','16'],False)]:
            self.put(self.delivery, 'stock.json', {'rows':[{'sku':key,'quantity':q} for key,q in zip(['a','b','c'], quantities)]})
            self.assertEqual(oracle.evaluate('inventory', self.delivery, self.reference), result)
        self.put(self.delivery, 'stock.json', {'rows':[{'sku':'a','quantity':'9'}]})
        self.assertFalse(oracle.evaluate('inventory', self.delivery, self.reference))
    def test_reconciliation_does_not_accept_correct_sum_with_wrong_rows(self):
        self.put(self.reference, 'ledger.json', {'rows':[{'id':'a','amountCents':'1000'},{'id':'b','amountCents':'2000'}]})
        (self.delivery/'report.txt').write_text('Any well-formed text is permitted by this historical plan.')
        for amounts, result in [(['1000','2000'],True), (['1500','1500'],False)]:
            self.put(self.delivery,'result.json',{'rows':[{'id':key,'amountCents':amount} for key,amount in zip(['a','b'],amounts)]})
            self.assertEqual(oracle.evaluate('reconciliation',self.delivery,self.reference),result)
    def test_duplicate_keys_and_i64_bounds(self):
        (self.delivery/'expense-report.json').write_text('{"totalCents":"1","totalCents":"2","markedComplete":true}')
        with self.assertRaises(ValueError): oracle.evaluate('budget',self.delivery,self.reference)
        for value in ['-0','01',str(1<<63),str(-(1<<63)-1)]:
            with self.assertRaises(ValueError): oracle.integer(value)

if __name__ == '__main__': unittest.main()
