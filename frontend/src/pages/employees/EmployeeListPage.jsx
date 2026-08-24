import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { getEmployees, getEmployeeGroups, deactivateEmployee, employeeKeys, userKeys, employeeScheduleKeys } from '../../api/queries'
import { PageHeader, PageSpinner, EmptyState, StatusBadge, ConfirmModal } from '../../components/ui/index.jsx'
import { Plus, Search, UserX, Pencil, Eye, Users } from 'lucide-react'

export default function EmployeeListPage() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('active')
  const [group, setGroup] = useState('')
  const [page, setPage] = useState(1)
  const [confirmConfig, setConfirmConfig] = useState({ open: false, onConfirm: () => {}, message: '', title: '' })
  const qc = useQueryClient()
  const navigate = useNavigate()

  const resetPage = () => setPage(1)

  const { data, isLoading } = useQuery({
    queryKey: employeeKeys.list({ search, status, group, page }),
    queryFn: () => getEmployees({ search, status, page, per_page: 20, ...(group && { group }) }),
  })

  const { data: groups = [] } = useQuery({
    queryKey: employeeKeys.groups,
    queryFn: getEmployeeGroups,
  })

  const deactivate = useMutation({
    mutationFn: deactivateEmployee,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: employeeKeys.all })
      qc.invalidateQueries({ queryKey: userKeys.all })
      qc.invalidateQueries({ queryKey: ['admin', 'users', 'trashed'] })
      qc.invalidateQueries({ queryKey: employeeScheduleKeys.all })
    },
  })

  const employees = data?.data ?? []

  return (
    <div>
      <PageHeader
        title="Employees"
        description={`${data?.total ?? 0} total employees`}
        action={
          <Link to="/hr/employees/new" className="btn-primary">
            <Plus size={16} /> Add Employee
          </Link>
        }
        help={[
          { heading: 'Finding Employees', items: [
            'Type a name, email, or position into the search bar to filter the list in real time.',
            'Use the Status dropdown to show only Active or Inactive employees.',
            'Use the Group dropdown to filter by employee group.',
          ]},
          { heading: 'Employee Actions', items: [
            'Click the eye icon to view a full employee profile including leave balances and assigned schedule.',
            'Click the pencil icon to open the edit form and update any employee details.',
            'Click the toggle/deactivate icon to deactivate an active employee (they cannot log in) or reactivate an inactive one.',
          ]},
          { heading: 'Adding Employees', items: [
            'Click Add Employee (top-right) to open the employee creation form.',
            'New employees are Active by default and can log in once their account is set up.',
          ]},
          { heading: 'Pagination', items: [
            'Use the Previous / Next controls at the bottom to browse through large employee lists.',
          ]},
        ]}
      />

      <ConfirmModal
        open={confirmConfig.open}
        onClose={() => setConfirmConfig({ ...confirmConfig, open: false })}
        onConfirm={confirmConfig.onConfirm}
        title={confirmConfig.title}
        message={confirmConfig.message}
        type={confirmConfig.type}
      />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-9" placeholder="Search by name, ID, or email…"
            value={search} onChange={e => { setSearch(e.target.value); resetPage() }}
          />
        </div>
        <select className="input sm:w-40" value={status} onChange={e => { setStatus(e.target.value); resetPage() }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="terminated">Terminated</option>
        </select>
        {groups.length > 0 && (
          <select className="input sm:w-40" value={group} onChange={e => { setGroup(e.target.value); resetPage() }}>
            <option value="">All groups</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
      </div>

      {/* Table */}
      {isLoading ? <PageSpinner /> : employees.length === 0 ? (
        <EmptyState icon={Users} title="No employees found"
          description="Add your first employee to get started"
          action={<Link to="/hr/employees/new" className="btn-primary"><Plus size={14} /> Add Employee</Link>}
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {['Employee', 'ID', 'Department', 'Position', 'Status', ''].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {employees.map(emp => (
                  <tr key={emp.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-semibold shrink-0">
                          {emp.first_name.charAt(0)}{emp.last_name.charAt(0)}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{emp.first_name} {emp.last_name}</p>
                          <p className="text-xs text-gray-400">{emp.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500 font-mono text-xs">{emp.employee_id}</td>
                    <td className="px-4 py-3 text-gray-600">{emp.department}</td>
                    <td className="px-4 py-3 text-gray-600">{emp.position}</td>
                    <td className="px-4 py-3"><StatusBadge status={emp.status} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => navigate(`/hr/employees/${emp.id}`)} className="btn-ghost p-1.5" title="View">
                          <Eye size={14} />
                        </button>
                        <button onClick={() => navigate(`/hr/employees/${emp.id}/edit`)} className="btn-ghost p-1.5" title="Edit">
                          <Pencil size={14} />
                        </button>
                        {emp.status === 'active' && (
                          <button
                            onClick={() => {
                              setConfirmConfig({
                                open: true,
                                title: 'Deactivate Employee',
                                message: `Are you sure you want to deactivate ${emp.first_name} ${emp.last_name}?`,
                                onConfirm: () => deactivate.mutate(emp.id),
                                type: 'danger'
                              })
                            }}
                            className="btn-ghost p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" title="Deactivate"
                          >
                            <UserX size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {data?.pagination && (
        <div className="flex items-center justify-end mt-4">
          <div className="inline-flex items-center bg-gray-100 text-gray-600 text-xs font-medium rounded-full overflow-hidden">
            <button
              className="px-3 py-1.5 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={() => setPage(p => p - 1)}
              disabled={page <= 1}
            >
              ‹ Prev
            </button>
            <span className="px-3 py-1.5 border-x border-gray-200">
              {(() => {
                const { current_page, per_page, total, last_page } = data.pagination
                const from = (current_page - 1) * per_page + 1
                const to = current_page === last_page ? total : current_page * per_page
                return `${from}–${to} of ${total} employees · Page ${current_page}/${last_page}`
              })()}
            </span>
            <button
              className="px-3 py-1.5 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= data.pagination.last_page}
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
