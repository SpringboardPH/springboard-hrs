import React from 'react'
import { Modal } from '../ui'

export function HolidayRewriteModal({ open, onClose, onConfirm, plan, confirming = false }) {
  const convert = plan?.convert ?? []
  const skipped = plan?.skipped_sandwich ?? []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm holiday attendance"
      size="lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-700">
          {convert.length} employee(s) currently Absent will be changed to Holiday.
        </p>

        {convert.length > 0 && (
          <ul className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50 text-sm">
            {convert.map((row) => (
              <li key={row.log_id} className="px-3 py-2 text-gray-800">
                {row.employee_name} {row.date}
              </li>
            ))}
          </ul>
        )}

        {skipped.length > 0 && (
          <>
            <p className="text-sm text-gray-700">
              {skipped.length} skipped because they were Absent the day before or after.
            </p>
            <ul className="max-h-32 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50 text-sm">
              {skipped.map((row) => (
                <li key={row.log_id} className="px-3 py-2 text-gray-800">
                  {row.employee_name} {row.date}
                </li>
              ))}
            </ul>
          </>
        )}

        <p className="text-xs text-gray-500">
          Draft payrolls for overlapping cutoffs stay unchanged until you Generate for Period.
        </p>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={confirming}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} className="btn-primary" disabled={confirming}>
            {confirming ? 'Saving...' : 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
