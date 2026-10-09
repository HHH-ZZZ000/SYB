"""Read-only record queries. Legacy telemetry history and upload stay unchanged."""
import csv
import io
import re
from datetime import datetime, timedelta, timezone

from flask import Response, jsonify, request, stream_with_context

if __package__:
    from . import database
else:
    import database


def register_records(app, selected_device, serialize_sample):
    def filters():
        clauses, values = ["device = ?"], [selected_device()]
        times = {}
        for key, op in (("start", ">="), ("end", "<=")):
            value = request.args.get(key)
            if value:
                try:
                    # datetime-local controls use Beijing wall time, never browser timezone.
                    parsed = datetime.fromisoformat(value)
                    if parsed.tzinfo is not None:
                        raise ValueError()
                    epoch = parsed.replace(tzinfo=timezone(timedelta(hours=8))).timestamp()
                except (ValueError, OverflowError):
                    raise ValueError("Invalid Beijing date/time filter.")
                times[key] = epoch
                clauses.append(f"received_at {op} ?")
                values.append(epoch)
        if times.get("start", float('-inf')) > times.get("end", float('inf')):
            raise ValueError("Start time must not be after end time.")
        order = request.args.get("order", "desc")
        if order not in ("asc", "desc"):
            raise ValueError("order must be asc or desc.")
        return " AND ".join(clauses), values, order.upper()

    @app.get('/api/records')
    def records():
        where, values, order = filters()
        page_text = request.args.get('page', '1')
        size_text = request.args.get('page_size', '20')
        if not re.fullmatch(r'[0-9]{1,7}', page_text) or int(page_text) < 1:
            raise ValueError('Invalid page.')
        if not re.fullmatch(r'[0-9]{1,3}', size_text) or not 1 <= int(size_text) <= 100:
            raise ValueError('page_size must be between 1 and 100.')
        page, size = int(page_text), int(size_text)
        db = database.get_db()
        db.execute('BEGIN')
        try:
            # Count and page share a SQLite snapshot while new uploads continue.
            total = db.execute(f'SELECT COUNT(*) FROM sensor_data WHERE {where}', values).fetchone()[0]
            rows = db.execute(
                f'SELECT * FROM sensor_data WHERE {where} ORDER BY received_at {order}, id {order} LIMIT ? OFFSET ?',
                [*values, size, (page - 1) * size],
            ).fetchall()
        finally:
            db.rollback()
        return jsonify(samples=[serialize_sample(row) for row in rows], total=total, page=page, page_size=size)

    @app.get('/api/records/export')
    def export_records():
        where, values, order = filters()

        @stream_with_context
        def generate():
            stream = io.StringIO()
            writer = csv.writer(stream)
            fields = ['id', 'device', 'sensor', 'timestamp', 'received_at', 'acc_x', 'acc_y', 'acc_z']
            writer.writerow(['记录编号', '设备', '传感器', '采样时间（北京时间）', '接收时间（UTC）', 'X / g', 'Y / g', 'Z / g'])
            yield '\ufeff' + stream.getvalue()
            cursor = database.get_db().execute(
                f'SELECT * FROM sensor_data WHERE {where} ORDER BY received_at {order}, id {order}', values)
            try:
                while True:
                    rows = cursor.fetchmany(500)
                    if not rows:
                        break
                    stream.seek(0)
                    stream.truncate()
                    for row in rows:
                        sample = serialize_sample(row)
                        cells = [sample[field] for field in fields]
                        # Device IDs may legally start with '-'; Excel must treat them as text.
                        cells = ["'" + value if isinstance(value, str) and value.startswith(('=', '+', '-', '@', '\t', '\r', '\n')) else value for value in cells]
                        writer.writerow(cells)
                    yield stream.getvalue()
            finally:
                cursor.close()
        return Response(generate(), content_type='text/csv; charset=utf-8', headers={
            'Content-Disposition': 'attachment; filename="imu-history.csv"',
        })
