// fork addition, see FORK_NOTES.md
import { X } from 'lucide-react';

export default function JobSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative mb-3 w-full sm:w-64">
      <input
        type="text"
        aria-label="Search Jobs"
        placeholder="Search jobs"
        value={value}
        onChange={event => onChange(event.target.value)}
        className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 pl-3 pr-9 text-sm text-gray-100 placeholder-gray-400 focus:border-blue-500 focus:outline-none sm:py-1"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear Search"
          title="Clear search"
          onClick={() => onChange('')}
          className="absolute inset-y-0 right-0 flex items-center px-2 text-gray-400 hover:text-gray-100 focus-visible:outline focus-visible:outline-blue-500"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
