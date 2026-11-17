"""Independent domain checks for the three fresh engine proof workloads.

These checks implement the approved workload rules directly. They do not parse
or interpret engine plans. Historical input schemas remain historical fixtures.
"""
import json
from pathlib import Path

MINIMUM = -(1 << 63)
MAXIMUM = (1 << 63) - 1

def integer(value):
    if not isinstance(value, str) or str(int(value)) != value:
        raise ValueError('Expected a canonical integer string')
    number = int(value)
    if not MINIMUM <= number <= MAXIMUM:
        raise ValueError('Integer exceeds i64')
    return number

def json_file(directory, name):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate key')
            result[key] = value
        return result
    return json.loads((Path(directory) / name).read_text(encoding='utf-8'), object_pairs_hook=pairs)

def evaluate(family, delivery, reference):
    delivery, reference = Path(delivery), Path(reference)
    if family == 'budget':
        result = json_file(delivery, 'expense-report.json')
        amount = integer(result['totalCents'])
        if type(result['markedComplete']) is not bool:
            raise ValueError('Completion must be Boolean')
        return amount <= 10000 and result['markedComplete']
    if family == 'inventory':
        rows = json_file(delivery, 'stock.json')['rows']
        catalog = json_file(reference, 'catalog.json')['rows']
        caps = {row['sku']: (integer(row['minimum']), integer(row['maximum'])) for row in catalog}
        amounts = [integer(row['quantity']) for row in rows]
        if len(rows) != len(catalog) or len({row['sku'] for row in rows}) != len(rows):
            return False
        if any(row['sku'] not in caps for row in rows):
            raise ValueError('Unknown SKU')
        return all(caps[row['sku']][0] <= value <= caps[row['sku']][1]
                   for row, value in zip(rows, amounts)) and sum(amounts) <= 47
    if family == 'reconciliation':
        rows = json_file(delivery, 'result.json')['rows']
        ledger = json_file(reference, 'ledger.json')['rows']
        (delivery / 'report.txt').read_text(encoding='utf-8')
        expected = {row['id']: integer(row['amountCents']) for row in ledger}
        amounts = [integer(row['amountCents']) for row in rows]
        if not rows or len(rows) != len(ledger) or len({row['id'] for row in rows}) != len(rows):
            return False
        if any(row['id'] not in expected for row in rows):
            raise ValueError('Unknown invoice')
        return sum(amounts) == sum(expected.values()) and all(
            value == expected[row['id']] for row, value in zip(rows, amounts))
    raise ValueError('Unknown workload')

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('family', choices=['budget', 'inventory', 'reconciliation'])
    parser.add_argument('delivery', type=Path)
    parser.add_argument('reference', type=Path)
    args = parser.parse_args()
    verdict = evaluate(args.family, args.delivery, args.reference)
    print(json.dumps({'family': args.family, 'verdict': int(verdict)}))
