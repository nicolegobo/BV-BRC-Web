define([
  'dojo/_base/declare', 'dojo/_base/lang', 'dojo/request', 'dojo/dom-construct', 'dojo/on',
  'dijit/_WidgetBase', 'dijit/_TemplatedMixin', 'dijit/_WidgetsInTemplateMixin',
  'dojo/text!./templates/SimilarGenomeTaxonFinder.html', '../WorkspaceManager'
], function (
  declare, lang, xhr, domConstruct, on,
  WidgetBase, Templated, WidgetsInTemplate,
  Template, WorkspaceManager
) {

  // Suggests an organism for an annotation job by running the Similar Genome
  // Finder (MinHash) on the job's input, limited to Reference and
  // Representative genomes. The owning form supplies getInputPath() and
  // handles onSelect(taxon) by filling its taxonomy fields.
  //
  // The inner widgets deliberately have no name attributes, so the owning
  // form's getValues() does not pick them up as job parameters.
  return declare([WidgetBase, Templated, WidgetsInTemplate], {
    templateString: Template,

    // Same cutoffs as the Similar Genome Finder service's defaults, so the
    // closest genomes are always listed; read files score lower than contigs
    // and a stricter distance often leaves nothing to show.
    maxDistance: 1,
    maxPvalue: 1,

    // Est. ANI at which a hit indicates the same species.
    speciesAni: 92,

    // The list shows the closest showHits genomes, or every genome at
    // listAni Est. ANI or higher when there are more of those. maxHits is
    // how many the search returns to choose from.
    showHits: 5,
    listAni: 90,
    maxHits: 100,

    // While a file is still uploading, check again this often, this many
    // times (5 minutes).
    uploadRetryMs: 10000,
    uploadRetries: 30,

    // Set by the owning form. Returns a workspace path, or an object
    // { error: 'message' } when there is no usable input yet.
    getInputPath: null,

    postCreate: function () {
      this.inherited(arguments);
      this.setStatus(this.idleMessage);
    },

    idleMessage: 'The species is predicted when you choose an input file.',

    // Called by the owning form whenever its input may have changed. Searches
    // when path differs from the last input searched; a null path clears the
    // results. Quick successive calls are combined into one search.
    inputChanged: function (path) {
      clearTimeout(this._inputTimer);
      this._inputTimer = setTimeout(lang.hitch(this, function () {
        if ((path || null) === (this._input || null)) {
          return;
        }
        if (path) {
          this.search(path);
        } else {
          this.reset();
        }
      }), 300);
    },

    searchAgain: function () {
      var input = this.getInputPath ? this.getInputPath() : null;
      if (!input || input.error) {
        this.setStatus((input && input.error) || 'Select an input file first.');
        return;
      }
      this.search(input);
    },

    // Each search gets an id, and a response is used only if its search is
    // still the latest, so a slow search cannot overwrite a newer one.
    isCurrent: function (id) {
      return id === this._searchId;
    },

    search: function (input) {
      // Bacterial and viral genomes are always both searched.
      var include_bacterial = 1;
      var include_viral = 1;

      this.clearResults();
      this._input = input;
      var id = this._searchId = (this._searchId || 0) + 1;
      this._search = {
        input_file: input,
        include_bacterial: include_bacterial,
        include_viral: include_viral,
        max_hits: this.maxHits,
        max_distance: this.maxDistance,
        max_pvalue: this.maxPvalue
      };
      this.searchAgainNode.hidden = true;
      this.setBusy('Checking the input file...');
      this.checkFile(input, id, this.uploadRetries);
    },

    // Waits for an upload to finish, then runs the MinHash search.
    checkFile: function (input, id, retries) {
      WorkspaceManager.getObject(input, true).then(lang.hitch(this, function (file) {
        if (!this.isCurrent(id)) {
          return;
        }
        var isZip = /\.(bz2|bzip2|zip)$/.test(file.name);
        if (isZip) {
          return this.fail('Currently, only gzip compression is supported.');
        }
        if (!file.link_reference || !(file.size > 0)) {
          if (retries > 0) {
            this.setBusy('Waiting for the file to finish uploading...');
            setTimeout(lang.hitch(this, 'checkFile', input, id, retries - 1), this.uploadRetryMs);
            return;
          }
          return this.fail('The file has not finished uploading. Try again when the upload is complete.');
        }
        this.runSearch(input, id);
      }), lang.hitch(this, function () {
        if (this.isCurrent(id)) {
          this.fail('Could not read the input file from the workspace.');
        }
      }));
    },

    runSearch: function (input, id) {
      this.setBusy('Searching for similar genomes. This can take a few minutes for large read files...');
      var rpc = {
        version: '1.1',
        id: String(Math.random()).slice(2),
        method: 'Minhash.compute_genome_distance_for_fasta2',
        params: [input, this.maxPvalue, this.maxDistance, this._search.max_hits,
          1, 1, this._search.include_bacterial, this._search.include_viral]
      };
      xhr.post(window.App.genomedistanceServiceURL, {
        headers: { Authorization: window.App.authorizationToken || '', Accept: 'application/json' },
        handleAs: 'json',
        data: JSON.stringify(rpc)
      }).then(lang.hitch(this, function (res) {
        if (this.isCurrent(id)) {
          this.onSearchResult(res, id);
        }
      }), lang.hitch(this, function () {
        if (this.isCurrent(id)) {
          this.fail('Search failed. Use Search again to retry.');
        }
      }));
    },

    onSearchResult: function (res, id) {
      if (res && res.error) {
        return this.fail('Search error: ' + (res.error.message || JSON.stringify(res.error)));
      }
      var hits = (res && res.result && res.result[0]) || [];
      if (!hits.length) {
        this._record = lang.mixin({ hits: [] }, this._search);
        return this.fail('No similar Reference or Representative genome was found. Specify a taxonomy instead.');
      }
      hits.sort(function (a, b) { return parseFloat(a[1]) - parseFloat(b[1]); });
      var close = hits.filter(function (h) { return this.estimatedAni(parseFloat(h[1])) >= this.listAni; }, this).length;
      hits = hits.slice(0, Math.max(this.showHits, close));
      var genomeIds = hits.map(function (h) { return h[0]; });

      return this.solrQuery('genome', 'genome_id:(' + genomeIds.join(' OR ') + ')', genomeIds.length)
        .then(lang.hitch(this, function (genomes) {
          var byId = {};
          genomes.forEach(function (g) { byId[g.genome_id] = g; });
          var taxonIds = genomes.map(function (g) { return g.taxon_id; }).filter(Boolean);
          return this.solrQuery('taxonomy', 'taxon_id:(' + taxonIds.join(' OR ') + ')', taxonIds.length)
            .then(lang.hitch(this, function (taxa) {
              if (!this.isCurrent(id)) {
                return;
              }
              var taxById = {};
              taxa.forEach(function (t) { taxById[t.taxon_id] = t; });
              this.renderResults(hits.map(function (h) {
                var g = byId[h[0]] || {};
                return {
                  genome_id: h[0],
                  genome_name: g.genome_name || h[0],
                  distance: parseFloat(h[1]),
                  pvalue: parseFloat(h[2]),
                  kmer_counts: String(h[3]),
                  taxon: this.speciesOf(g, taxById[g.taxon_id])
                };
              }, this));
            }));
        }), lang.hitch(this, function () {
          if (this.isCurrent(id)) {
            this.fail('Found similar genomes but could not look up their taxonomy.');
          }
        }));
    },

    // Suggest the species, not the reference genome's own (often strain-level)
    // taxon: a MinHash match says which species this is, not which strain.
    speciesOf: function (genome, taxon) {
      if (taxon && taxon.lineage_ranks) {
        var i = taxon.lineage_ranks.indexOf('species');
        if (i >= 0) {
          return { taxon_id: String(taxon.lineage_ids[i]), taxon_name: taxon.lineage_names[i] };
        }
      }
      return genome.taxon_id ? { taxon_id: String(genome.taxon_id), taxon_name: genome.species || genome.genome_name } : null;
    },

    solrQuery: function (core, q, rows) {
      return xhr.post(window.App.dataAPI + core + '/', {
        headers: {
          Authorization: window.App.authorizationToken || '',
          Accept: 'application/json',
          'Content-Type': 'application/solrquery+x-www-form-urlencoded',
          'X-Requested-With': null
        },
        handleAs: 'json',
        data: { rows: rows, q: q }
      });
    },

    // Est. ANI from Mash distance, which approximates 1 - ANI (Ondov et al. 2016).
    estimatedAni: function (distance) {
      return Math.round((1 - distance) * 1000) / 10;
    },

    renderResults: function (rows) {
      this._record = lang.mixin({
        hits: rows.map(function (row) {
          return {
            genome_id: row.genome_id,
            genome_name: row.genome_name,
            species_taxon_id: row.taxon ? row.taxon.taxon_id : null,
            species_name: row.taxon ? row.taxon.taxon_name : null,
            distance: row.distance,
            pvalue: row.pvalue,
            kmer_counts: row.kmer_counts,
            est_ani: this.estimatedAni(row.distance)
          };
        }, this)
      }, this._search);
      this.searchAgainNode.hidden = false;

      var first = null;
      rows.forEach(function (row) {
        var tr = domConstruct.create('tr', {}, this.resultsBody);
        // Plain radio, not a dijit one: the owning form's getValues() must not
        // collect it, and one name per widget keeps the forms' groups apart.
        row.radio = domConstruct.create('input', { type: 'radio', name: this.id + '_hit', disabled: !row.taxon }, domConstruct.create('td', {}, tr));
        domConstruct.create('td', { textContent: row.genome_name, title: row.genome_id }, tr);
        domConstruct.create('td', { textContent: row.taxon ? row.taxon.taxon_name : '' }, tr);
        domConstruct.create('td', { innerHTML: row.distance.toFixed(4), 'class': 'num' }, tr);
        domConstruct.create('td', { innerHTML: row.pvalue ? row.pvalue.toExponential(1) : '0', 'class': 'num' }, tr);
        domConstruct.create('td', { textContent: row.kmer_counts, 'class': 'num' }, tr);
        domConstruct.create('td', { innerHTML: this.estimatedAni(row.distance).toFixed(1) + '%', 'class': 'num' }, tr);
        row.tr = tr;
        if (!row.taxon) {
          tr.className = 'unavailable';
          tr.title = 'Taxonomy for this genome could not be found';
          return;
        }
        first = first || row;
        on(tr, 'click', lang.hitch(this, function () { this.selectRow(row); }));
      }, this);

      this.toggleNode.innerHTML = 'View similar genomes (' + rows.length + ') <i class="fa icon-caret-right"></i>';
      // Search options move into the expandable list, next to the results
      // they produced.
      domConstruct.place(this.controlsNode, this.detailsNode, 'last');
      if (!first) {
        this.setStatus('Similar genomes were found, but their taxonomy could not be looked up. Specify a taxonomy instead.');
        this.detailsNode.hidden = false;
        return;
      }
      var bestAni = Math.max.apply(null, rows.map(function (row) { return this.estimatedAni(row.distance); }, this));
      if (bestAni >= this.speciesAni) {
        this.setStatus('');
      } else {
        this.setStatus('<b>No result reaches ' + this.speciesAni + '% Est. ANI</b>, the level we expect for a genome of the same species. ' +
          'Use the prediction only if you are confident it is the right species, or specify a different taxonomy. ' +
          'Read files can score a few points lower than assembled contigs, and a mixed sample can score lower still.');
      }
      this.summaryNode.hidden = false;
      this.selectRow(first, true);
    },

    // Makes row the prediction: shown in the summary, saved with the job, and
    // passed to the owning form. auto is true for the top hit chosen when
    // results arrive, false when the submitter clicked the row.
    selectRow: function (row, auto) {
      this.resultsBody.querySelectorAll('tr').forEach(function (r) { r.classList.remove('selected'); });
      row.tr.classList.add('selected');
      row.radio.checked = true;
      this._selected = row.taxon;
      this._record.selected_genome_id = row.genome_id;
      this._record.selected_taxon_id = row.taxon.taxon_id;
      this.speciesNode.textContent = row.taxon.taxon_name;
      this.taxidNode.textContent = '(Taxonomy ID: ' + row.taxon.taxon_id + ')';
      this.aniNode.textContent = this.estimatedAni(row.distance).toFixed(1) + '%';
      this.onSelect(row.taxon, row, !!auto);
    },

    toggleDetails: function () {
      var open = this.detailsNode.hidden;
      this.detailsNode.hidden = !open;
      var count = this._record ? this._record.hits.length : 0;
      this.toggleNode.innerHTML = open ?
        'Hide similar genomes <i class="fa icon-caret-down"></i>' :
        'View similar genomes (' + count + ') <i class="fa icon-caret-right"></i>';
    },

    // Extension point for the owning form.
    onSelect: function (taxon, hit, auto) {
    },

    // The predicted species ({ taxon_id, taxon_name }), or null before a
    // search has found one.
    getPrediction: function () {
      return this._selected || null;
    },

    // The search the submitter ran, for the job's similar_genome_finder
    // parameter, or null if no search has completed.
    getRecord: function () {
      return this._record || null;
    },

    clearResults: function () {
      this._record = null;
      this._selected = null;
      domConstruct.empty(this.resultsBody);
      this.summaryNode.hidden = true;
      this.detailsNode.hidden = true;
      domConstruct.place(this.controlsNode, this.domNode.firstElementChild, 'last');
    },

    // Back to the state before any input: also drops a search in progress.
    reset: function () {
      clearTimeout(this._inputTimer);
      this._searchId = (this._searchId || 0) + 1;
      this._input = null;
      this.clearResults();
      this.searchAgainNode.hidden = true;
      this.setStatus(this.idleMessage);
    },

    fail: function (msg) {
      this.searchAgainNode.hidden = false;
      this.setStatus(msg);
    },

    setBusy: function (msg) {
      this.setStatus('<i class="fa icon-spinner fa-spin"></i> ' + msg);
    },

    setStatus: function (msg) {
      this.statusNode.innerHTML = msg;
    }
  });
});
